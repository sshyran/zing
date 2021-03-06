# -*- coding: utf-8 -*-
#
# Copyright (C) Pootle contributors.
# Copyright (C) Zing contributors.
#
# This file is a part of the Zing project. It is distributed under the GPL3
# or later license. See the LICENSE file for a copy of the license and the
# AUTHORS file for copyright and authorship information.

import io
import logging
import operator
from collections import OrderedDict
from hashlib import md5
from urllib.parse import quote

from translate.filters.decorators import Category
from translate.storage import base
from translate.storage.factory import getobject

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import F
from django.urls import reverse
from django.utils import timezone
from django.utils.functional import cached_property
from django.utils.translation import gettext_lazy as _

from pootle.core.log import (
    MUTE_QUALITYCHECK,
    STORE_ADDED,
    STORE_DELETED,
    STORE_OBSOLETE,
    TRANSLATION_ADDED,
    TRANSLATION_CHANGED,
    TRANSLATION_DELETED,
    UNIT_ADDED,
    UNIT_DELETED,
    UNIT_OBSOLETE,
    UNIT_RESURRECTED,
    UNMUTE_QUALITYCHECK,
    action_log,
    store_log,
)
from pootle.core.mixins import CachedMethods, CachedTreeItem
from pootle.core.models import Revision
from pootle.core.search import SearchBroker
from pootle.core.storage import PootleFileSystemStorage
from pootle.core.url_helpers import (
    get_editor_filter,
    split_pootle_path,
    to_tp_relative_path,
)
from pootle.core.utils import dateformat
from pootle.core.utils.aggregate import max_column
from pootle.core.utils.multistring import PLURAL_PLACEHOLDER, SEPARATOR
from pootle.core.utils.timezone import datetime_min
from pootle_misc.checks import check_names
from pootle_misc.util import import_func
from pootle_statistics.models import Submission, SubmissionFields, SubmissionTypes

from .constants import FUZZY, NEW, OBSOLETE, PARSED, TRANSLATED, UNTRANSLATED
from .fields import MultiStringField, TranslationStoreField
from .managers import StoreManager, SuggestionManager, UnitManager
from .syncer import PoStoreSyncer
from .updater import StoreUpdater
from .util import SuggestionStates


TM_BROKER = None


def get_tm_broker():
    global TM_BROKER
    if TM_BROKER is None:
        TM_BROKER = SearchBroker()
    return TM_BROKER


# # # # # # # # Quality Check # # # # # # #


class QualityCheck(models.Model):
    """Database cache of results of qualitychecks on unit."""

    name = models.CharField(max_length=64, db_index=True)
    unit = models.ForeignKey(
        "pootle_store.Unit", db_index=True, on_delete=models.CASCADE
    )
    category = models.IntegerField(null=False, default=Category.NO_CATEGORY)
    message = models.TextField()
    false_positive = models.BooleanField(default=False, db_index=True)

    def __str__(self):
        return self.name

    @property
    def display_name(self):
        return check_names.get(self.name, self.name)

    @classmethod
    def delete_unknown_checks(cls):
        unknown_checks = QualityCheck.objects.exclude(name__in=list(check_names.keys()))
        unknown_checks.delete()


# # # # # # # # # Suggestion # # # # # # # #


class Suggestion(models.Model, base.TranslationUnit):
    """Suggested translation for a :cls:`~pootle_store.models.Unit`, provided
    by users or automatically generated after a merge.
    """

    target_f = MultiStringField()
    target_hash = models.CharField(max_length=32, db_index=True)
    unit = models.ForeignKey("pootle_store.Unit", on_delete=models.CASCADE)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=False,
        related_name="suggestions",
        db_index=True,
        on_delete=models.CASCADE,
    )
    reviewer = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        related_name="reviews",
        db_index=True,
        on_delete=models.CASCADE,
    )

    translator_comment_f = models.TextField(null=True, blank=True)

    state_choices = [
        (SuggestionStates.PENDING, _("Pending")),
        (SuggestionStates.ACCEPTED, _("Accepted")),
        (SuggestionStates.REJECTED, _("Rejected")),
    ]
    state = models.CharField(
        max_length=16,
        default=SuggestionStates.PENDING,
        null=False,
        choices=state_choices,
        db_index=True,
    )

    creation_time = models.DateTimeField(db_index=True, null=True)
    review_time = models.DateTimeField(null=True, db_index=True)

    objects = SuggestionManager()

    # # # # # # # # # # # # # #  Properties # # # # # # # # # # # # # # # # # #

    @property
    def _target(self):
        return self.target_f

    @_target.setter
    def _target(self, value):
        self.target_f = value
        self._set_hash()

    @property
    def _source(self):
        return self.unit._source

    @property
    def translator_comment(self):
        return self.translator_comment_f

    @translator_comment.setter
    def translator_comment(self, value):
        self.translator_comment_f = value
        self._set_hash()

    # # # # # # # # # # # # # #  Methods # # # # # # # # # # # # # # # # # # #

    def __str__(self):
        return str(self.target)

    def _set_hash(self):
        string = self.translator_comment_f
        if string:
            string = self.target_f + SEPARATOR + string
        else:
            string = self.target_f
        self.target_hash = md5(string.encode("utf-8")).hexdigest()


# # # # # # # # Unit # # # # # # # # # #

wordcount_f = import_func(settings.ZING_WORDCOUNT_FUNC)


def count_words(strings):
    wordcount = 0

    for string in strings:
        wordcount += wordcount_f(string)

    return wordcount


def stringcount(string):
    try:
        return len(string.strings)
    except AttributeError:
        return 1


class Unit(models.Model, base.TranslationUnit):
    store = models.ForeignKey(
        "pootle_store.Store", db_index=True, on_delete=models.CASCADE
    )
    index = models.IntegerField(db_index=True)
    unitid = models.TextField(editable=False)
    unitid_hash = models.CharField(max_length=32, db_index=True, editable=False)

    source_f = MultiStringField(null=True)
    source_hash = models.CharField(max_length=32, db_index=True, editable=False)
    source_wordcount = models.SmallIntegerField(default=0, editable=False)
    source_length = models.SmallIntegerField(db_index=True, default=0, editable=False)

    target_f = MultiStringField(null=True, blank=True)
    target_wordcount = models.SmallIntegerField(default=0, editable=False)
    target_length = models.SmallIntegerField(db_index=True, default=0, editable=False)

    developer_comment = models.TextField(null=True, blank=True)
    translator_comment = models.TextField(null=True, blank=True)
    locations = models.TextField(null=True, editable=False)
    context = models.TextField(null=True, editable=False)

    state = models.IntegerField(null=False, default=UNTRANSLATED, db_index=True)
    revision = models.IntegerField(null=False, default=0, db_index=True, blank=True)

    # Metadata
    creation_time = models.DateTimeField(
        auto_now_add=True, db_index=True, editable=False, null=True
    )
    mtime = models.DateTimeField(auto_now=True, db_index=True, editable=False)

    # unit translator
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        db_index=True,
        related_name="submitted",
        on_delete=models.CASCADE,
    )
    submitted_on = models.DateTimeField(db_index=True, null=True)

    commented_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        db_index=True,
        related_name="commented",
        on_delete=models.CASCADE,
    )
    commented_on = models.DateTimeField(db_index=True, null=True)

    # reviewer: who has accepted suggestion or removed FUZZY
    # None if translation has been submitted by approved translator
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        db_index=True,
        related_name="reviewed",
        on_delete=models.CASCADE,
    )
    reviewed_on = models.DateTimeField(db_index=True, null=True)

    objects = UnitManager()
    simple_objects = models.Manager()

    class Meta(object):
        unique_together = ("store", "unitid_hash")
        get_latest_by = "mtime"
        index_together = [["store", "index"], ["store", "revision"], ["store", "mtime"]]

    # # # # # # # # # # # # # #  Properties # # # # # # # # # # # # # # # # # #

    @property
    def _source(self):
        return self.source_f

    @_source.setter
    def _source(self, value):
        self.source_f = value
        self._source_updated = True

    @property
    def _target(self):
        return self.target_f

    @_target.setter
    def _target(self, value):
        self.target_f = value
        self._target_updated = True

    @cached_property
    def terminology(self):
        """Retrieves terminology suggestions."""
        matcher = self.store.translation_project.gettermmatcher()
        if matcher is None:
            return []

        return matcher.matches(self.source)

    # # # # # # # # # # # # # Class & static methods # # # # # # # # # # # # #

    @classmethod
    def max_revision(cls):
        """Returns the max revision number across all units."""
        return max_column(cls.objects.all(), "revision", 0)

    # # # # # # # # # # # # # #  Methods # # # # # # # # # # # # # # # # # # #

    def __str__(self):
        # FIXME: consider using unit id instead?
        return str(self.source)

    def __init__(self, *args, **kwargs):
        super(Unit, self).__init__(*args, **kwargs)
        self._rich_source = None
        self._source_updated = False
        self._rich_target = None
        self._target_updated = False
        self._state_updated = False
        self._comment_updated = False
        self._auto_translated = False
        self._encoding = "UTF-8"

    # should be called to flag the store cache for a deletion
    # before the unit will be deleted
    def flag_store_before_going_away(self):
        self.store.mark_dirty(CachedMethods.WORDCOUNT_STATS)

        if self.suggestion_set.pending().count() > 0:
            self.store.mark_dirty(CachedMethods.SUGGESTIONS)

        if self.get_qualitychecks().filter(false_positive=False):
            self.store.mark_dirty(CachedMethods.CHECKS)

        # Check if unit currently being deleted is the one referenced in
        # last_action
        la = self.store.get_cached_value(CachedMethods.LAST_ACTION)
        if not la or "id" not in la or la["id"] == self.id:
            self.store.mark_dirty(CachedMethods.LAST_ACTION)
        # and last_updated
        lu = self.store.get_cached_value(CachedMethods.LAST_UPDATED)
        if not lu:
            self.store.mark_dirty(CachedMethods.LAST_UPDATED)

    def delete(self, *args, **kwargs):
        action_log(
            user="system",
            action=UNIT_DELETED,
            lang=self.store.translation_project.language.code,
            unit=self.id,
            translation="",
            path=self.store.pootle_path,
        )

        self.flag_store_before_going_away()

        super(Unit, self).delete(*args, **kwargs)

    def save(self, *args, **kwargs):
        created = self.id is None

        if not hasattr(self, "_log_user"):
            User = get_user_model()
            self._log_user = User.objects.get_system_user()
        user = kwargs.pop("user", self._log_user)

        if created:
            self._save_action = UNIT_ADDED
            self.store.mark_dirty(
                CachedMethods.WORDCOUNT_STATS, CachedMethods.LAST_UPDATED
            )

        if self._source_updated:
            # update source related fields
            self.source_hash = md5(self.source_f.encode("utf-8")).hexdigest()
            self.source_length = len(self.source_f)
            self.update_wordcount(auto_translate=True)

        if self._target_updated:
            # update target related fields
            self.target_wordcount = count_words(self.target_f.strings)
            self.target_length = len(self.target_f)
            self.store.mark_dirty(CachedMethods.LAST_ACTION)
            if [_f for _f in self.target_f.strings if _f]:
                if self.state == UNTRANSLATED:
                    self.state = TRANSLATED
                    self.store.mark_dirty(CachedMethods.WORDCOUNT_STATS)

                    if not hasattr(self, "_save_action"):
                        self._save_action = TRANSLATION_ADDED
                else:
                    if not hasattr(self, "_save_action"):
                        self._save_action = TRANSLATION_CHANGED
            else:
                if not hasattr(self, "_save_action"):
                    self._save_action = TRANSLATION_DELETED
                # if it was TRANSLATED then set to UNTRANSLATED
                if self.state > FUZZY:
                    self.state = UNTRANSLATED
                    self.store.mark_dirty(CachedMethods.WORDCOUNT_STATS)

        # Updating unit from the .po file set its revision property to
        # a new value (the same for all units during its store updated)
        # since that change doesn't require further sync but note that
        # auto_translated units require further sync
        revision = kwargs.pop("revision", None)
        if revision is not None and not self._auto_translated:
            self.revision = revision
        elif self._target_updated or self._state_updated or self._comment_updated:
            self.revision = Revision.incr()

        if not created and hasattr(self, "_save_action"):
            action_log(
                user=self._log_user,
                action=self._save_action,
                lang=self.store.translation_project.language.code,
                unit=self.id,
                translation=self.target_f,
                path=self.store.pootle_path,
            )

        if (
            self._state_updated
            and self.state == TRANSLATED
            and self._save_action == TRANSLATION_CHANGED
            and not self._target_updated
        ):
            # set reviewer data if FUZZY has been removed only and
            # translation hasn't been updated
            self.reviewed_on = timezone.now()
            self.reviewed_by = self._log_user
        elif self.state == FUZZY:
            # clear reviewer data if unit has been marked as FUZZY
            self.reviewed_on = None
            self.reviewed_by = None
        elif self.state == UNTRANSLATED:
            # clear reviewer and translator data if translation
            # has been deleted
            self.reviewed_on = None
            self.reviewed_by = None
            self.submitted_by = None
            self.submitted_on = None

        super(Unit, self).save(*args, **kwargs)

        if hasattr(self, "_save_action") and self._save_action == UNIT_ADDED:
            # just added FUZZY unit
            if self.state == FUZZY:
                self.store.mark_dirty(CachedMethods.WORDCOUNT_STATS)

            action_log(
                user=self._log_user,
                action=self._save_action,
                lang=self.store.translation_project.language.code,
                unit=self.id,
                translation=self.target_f,
                path=self.store.pootle_path,
            )

            self.add_initial_submission(user=user)

        if self._source_updated or self._target_updated:
            if not (created and self.state == UNTRANSLATED):
                self.update_qualitychecks()
            if self.istranslated():
                self.update_tmserver()

        # done processing source/target update remove flag
        self._source_updated = False
        self._target_updated = False
        self._state_updated = False
        self._comment_updated = False
        self._auto_translated = False

        # update cache only if we are updating a single unit
        if self.store.state >= PARSED:
            self.store.mark_dirty(CachedMethods.MTIME)
            self.store.update_dirty_cache()

    def get_absolute_url(self):
        return self.store.get_absolute_url()

    def get_translate_url(self):
        return "%s%s" % (self.store.get_translate_url(), "#unit=%s" % str(self.id))

    def get_search_locations_url(self):
        (proj_code, dir_path, filename) = split_pootle_path(self.store.pootle_path)[1:]

        return u"".join(
            [
                reverse(
                    "pootle-project-translate", args=[proj_code, dir_path, filename]
                ),
                get_editor_filter(search=self.locations, sfields="locations"),
            ]
        )

    def get_screenshot_url(self):
        prefix = self.store.translation_project.project.screenshot_search_prefix
        if prefix:
            return prefix + quote(self.source_f)

    def is_accessible_by(self, user):
        """Returns `True` if the current unit is accessible by `user`."""
        if user.is_superuser:
            return True

        from pootle_project.models import Project

        user_projects = Project.accessible_by_user(user)
        return self.store.translation_project.project.code in user_projects

    def add_initial_submission(self, user=None):
        if self.istranslated() or self.isfuzzy():
            Submission.objects.create(
                creation_time=self.creation_time,
                translation_project=self.store.translation_project,
                submitter=user or self._log_user,
                unit=self,
                store=self.store,
                type=SubmissionTypes.UNIT_CREATE,
                field=SubmissionFields.TARGET,
                new_value=self.target,
            )

    @cached_property
    def unit_syncer(self):
        return self.store.syncer.unit_sync_class(self)

    def convert(self, unitclass=None):
        """Convert to a unit of type :param:`unitclass` retaining as much
        information from the database as the target format can support.
        """
        return self.unit_syncer.convert(unitclass)

    def sync(self, unit):
        """Sync in file unit with translations from the DB."""
        changed = False

        if not self.isobsolete() and unit.isobsolete():
            unit.resurrect()
            changed = True

        if unit.target != self.target:
            if unit.hasplural():
                nplurals = self.store.translation_project.language.nplurals
                target_plurals = len(self.target.strings)
                strings = self.target.strings
                if target_plurals < nplurals:
                    strings.extend([u""] * (nplurals - target_plurals))
                if unit.target.strings != strings:
                    unit.target = strings
                    changed = True
            else:
                unit.target = self.target
                changed = True

        self_notes = self.getnotes(origin="translator")
        unit_notes = unit.getnotes(origin="translator")
        if unit_notes != (self_notes or ""):
            if self_notes != "":
                unit.addnote(self_notes, origin="translator", position="replace")
            else:
                unit.removenotes()
            changed = True

        if unit.isfuzzy() != self.isfuzzy():
            unit.markfuzzy(self.isfuzzy())
            changed = True

        if self.isobsolete() and not unit.isobsolete():
            unit.makeobsolete()
            changed = True

        return changed

    def update(self, unit, user=None):
        """Update in-DB translation from the given :param:`unit`.

        :param user: User to attribute updates to.
        :rtype: bool
        :return: True if the new :param:`unit` differs from the current unit.
            Two units differ when any of the fields differ (source, target,
            translator/developer comments, locations, context, status...).
        """
        changed = False

        if user is None:
            User = get_user_model()
            user = User.objects.get_system_user()

        if (
            self.source != unit.source
            or len(self.source.strings) != stringcount(unit.source)
            or self.hasplural() != unit.hasplural()
        ):

            if unit.hasplural() and len(unit.source.strings) == 1:
                self.source = [unit.source, PLURAL_PLACEHOLDER]
            else:
                self.source = unit.source

            changed = True

        if self.target != unit.target or len(self.target.strings) != stringcount(
            unit.target
        ):
            notempty = [_f for _f in self.target_f.strings if _f]
            self.target = unit.target

            if [_f for _f in self.target_f.strings if _f] or notempty:
                # FIXME: we need to do this cause we discard nplurals for empty
                # plurals
                changed = True

        notes = unit.getnotes(origin="developer")

        if self.developer_comment != notes and (self.developer_comment or notes):
            self.developer_comment = notes or None
            changed = True

        notes = unit.getnotes(origin="translator")

        if self.translator_comment != notes and (self.translator_comment or notes):
            self.translator_comment = notes or None
            changed = True
            self._comment_updated = True

        locations = "\n".join(unit.getlocations())
        if self.locations != locations and (self.locations or locations):
            self.locations = locations or None
            changed = True

        context = unit.getcontext()
        if self.context != unit.getcontext() and (self.context or context):
            self.context = context or None
            changed = True

        if self.isfuzzy() != unit.isfuzzy():
            self.markfuzzy(unit.isfuzzy())
            changed = True

        if self.isobsolete() != unit.isobsolete():
            if unit.isobsolete():
                self.makeobsolete()
            else:
                self.resurrect(unit.isfuzzy())

            changed = True

        if self.unitid != unit.getid():
            self.unitid = str(unit.getid()) or str(unit.source)
            self.unitid_hash = md5(self.unitid.encode("utf-8")).hexdigest()
            changed = True

        return changed

    def update_wordcount(self, auto_translate=False):
        """Updates the source wordcount for a unit.

        :param auto_translate: when set to `True`, it will copy the
            source string into the target field.
        """
        self.source_wordcount = count_words(self.source_f.strings)

        if self.source_wordcount == 0:
            # We can't set the actual wordcount to zero since the unit
            # will essentially disappear from statistics thus for such
            # units set word count to 1
            self.source_wordcount = 1

            if auto_translate and not bool([_f for _f in self.target_f.strings if _f]):
                # auto-translate untranslated strings
                self.target = self.source
                self.state = FUZZY
                self._auto_translated = True

    def update_qualitychecks(self, keep_false_positives=False):
        """Run quality checks and store result in the database.

        :param keep_false_positives: when set to `False`, it will activate
            (unmute) any existing false positive checks.
        :return: `True` if quality checks were updated or `False` if they
            left unchanged.
        """
        unmute_list = []
        result = False

        checks = self.qualitycheck_set.all()

        existing = {}
        for check in checks.values("name", "false_positive", "id"):
            existing[check["name"]] = {
                "false_positive": check["false_positive"],
                "id": check["id"],
            }

        # no checks if unit is untranslated
        if not self.target:
            if existing:
                self.store.mark_dirty(CachedMethods.CHECKS)
                self.qualitycheck_set.all().delete()
                return True

            return False

        checker = self.store.translation_project.checker
        qc_failures = checker.run_filters(self, categorised=True)
        checks_to_add = []
        for name in iter(qc_failures.keys()):
            if name in existing:
                # keep false-positive checks if check is active
                if existing[name]["false_positive"] and not keep_false_positives:
                    unmute_list.append(name)
                del existing[name]
                continue

            message = qc_failures[name]["message"]
            category = qc_failures[name]["category"]
            checks_to_add.append(
                QualityCheck(unit=self, name=name, message=message, category=category)
            )
            self.store.mark_dirty(CachedMethods.CHECKS)
            result = True

        if checks_to_add:
            self.qualitycheck_set.bulk_create(checks_to_add)

        if not keep_false_positives and unmute_list:
            self.qualitycheck_set.filter(name__in=unmute_list).update(
                false_positive=False
            )

        # delete inactive checks
        if existing:
            self.store.mark_dirty(CachedMethods.CHECKS)
            self.qualitycheck_set.filter(name__in=existing).delete()

        return result or bool(unmute_list) or bool(existing)

    def get_qualitychecks(self):
        return self.qualitycheck_set.all()

    def get_critical_qualitychecks(self):
        return self.get_qualitychecks().filter(category=Category.CRITICAL)

    def get_active_critical_qualitychecks(self):
        return self.get_active_qualitychecks().filter(category=Category.CRITICAL)

    def get_warning_qualitychecks(self):
        return self.get_qualitychecks().exclude(category=Category.CRITICAL)

    def get_active_qualitychecks(self):
        return self.qualitycheck_set.filter(false_positive=False)

    # # # # # # # # # # # Related Submissions # # # # # # # # # # # #

    def get_edits(self):
        return self.submission_set.get_unit_edits()

    def get_comments(self):
        return self.submission_set.get_unit_comments()

    def get_state_changes(self):
        return self.submission_set.get_unit_state_changes()

    def get_suggestion_reviews(self):
        return self.submission_set.get_unit_suggestion_reviews()

    # # # # # # # # # # # TranslationUnit # # # # # # # # # # # # # #

    def update_tmserver(self):
        obj = {
            "id": self.id,
            # 'revision' must be an integer for statistical queries to work
            "revision": self.revision,
            "project": self.store.translation_project.project.fullname,
            "path": self.store.pootle_path,
            "source": self.source,
            "target": self.target,
            "username": "",
            "fullname": "",
            "email_md5": "",
        }

        if self.submitted_on:
            obj.update({"mtime": int(dateformat.format(self.submitted_on, "U"))})

        if self.submitted_by:
            obj.update(
                {
                    "username": self.submitted_by.username,
                    "fullname": self.submitted_by.full_name,
                    "email_md5": md5(
                        self.submitted_by.email.encode("utf-8")
                    ).hexdigest(),
                }
            )

        get_tm_broker().update(self.store.translation_project.language.code, obj)

    def get_tm_suggestions(self):
        return get_tm_broker().search(self)

    # # # # # # # # # # # TranslationUnit # # # # # # # # # # # # # #

    def getnotes(self, origin=None):
        if origin is None:
            notes = ""
            if self.translator_comment is not None:
                notes += self.translator_comment
            if self.developer_comment is not None:
                notes += self.developer_comment
            return notes
        elif origin == "translator":
            return self.translator_comment or ""
        elif origin in ["programmer", "developer", "source code"]:
            return self.developer_comment or ""
        else:
            raise ValueError("Comment type not valid")

    def addnote(self, text, origin=None, position="append"):
        if not (text and text.strip()):
            return
        if origin in ["programmer", "developer", "source code"]:
            self.developer_comment = text
        else:
            self.translator_comment = text

    def getid(self):
        return self.unitid

    def setid(self, value):
        self.unitid = value
        self.unitid_hash = md5(self.unitid.encode("utf-8")).hexdigest()

    def getlocations(self):
        if self.locations is None:
            return []
        return [_f for _f in self.locations.split("\n") if _f]

    def addlocation(self, location):
        if self.locations is None:
            self.locations = ""
        self.locations += location + "\n"

    def getcontext(self):
        return self.context

    def setcontext(self, value):
        self.context = value

    def isfuzzy(self):
        return self.state == FUZZY

    def markfuzzy(self, value=True):
        if self.state <= OBSOLETE:
            return

        if value != (self.state == FUZZY):
            # when Unit toggles its FUZZY state the number of translated words
            # also changes
            self.store.mark_dirty(
                CachedMethods.WORDCOUNT_STATS, CachedMethods.LAST_ACTION
            )
            self._state_updated = True
            # that's additional check
            # but leave old value in case _save_action is set
            if not hasattr(self, "_save_action"):
                self._save_action = TRANSLATION_CHANGED

        if value:
            self.state = FUZZY
        elif self.state <= FUZZY:
            if [_f for _f in self.target_f.strings if _f]:
                self.state = TRANSLATED
            else:
                self.state = UNTRANSLATED
                # that's additional check
                # but leave old value in case _save_action is set
                if not hasattr(self, "_save_action"):
                    self._save_action = TRANSLATION_DELETED

    def hasplural(self):
        return self.source is not None and (
            len(self.source.strings) > 1
            or hasattr(self.source, "plural")
            and self.source.plural
        )

    def isobsolete(self):
        return self.state == OBSOLETE

    def makeobsolete(self):
        if self.state > OBSOLETE:
            # when Unit becomes obsolete the cache flags should be updated
            self.flag_store_before_going_away()
            self._state_updated = True
            self._save_action = UNIT_OBSOLETE

            self.state = OBSOLETE
            self.index = 0

    def resurrect(self, is_fuzzy=False):
        """Bring a unit's state back to life.

        :param is_fuzzy: whether the unit is in fuzzy state or not.
        :return: `True` if the unit was resurrected, `False` otherwise.
        """
        if self.state > OBSOLETE:
            return False

        if [_f for _f in self.target_f.strings if _f]:
            # when Unit toggles its OBSOLETE state the number of translated
            # words or fuzzy words also changes
            if is_fuzzy:
                self.state = FUZZY
            else:
                self.state = TRANSLATED
        else:
            self.state = UNTRANSLATED

        self.store.mark_dirty(CachedMethods.WORDCOUNT_STATS)
        self.update_qualitychecks(keep_false_positives=True)
        self._state_updated = True
        self._save_action = UNIT_RESURRECTED
        return True

    def istranslated(self):
        if self._target_updated and not self.isfuzzy():
            return bool([_f for _f in self.target_f.strings if _f])
        return self.state >= TRANSLATED

    # # # # # # # # # # # Suggestions # # # # # # # # # # # # # # # # #
    def get_suggestions(self):
        return self.suggestion_set.pending().select_related("user").all()

    def add_suggestion(
        self, translation, user=None, touch=True, similarity=None, mt_similarity=None
    ):
        """Adds a new suggestion to the unit.

        :param translation: suggested translation text
        :param user: user who is making the suggestion. If it's ``None``,
            the ``system`` user will be used.
        :param touch: whether to update the unit's timestamp after adding
            the suggestion or not.
        :param similarity: human similarity for the new suggestion.
        :param mt_similarity: MT similarity for the new suggestion.

        :return: a tuple ``(suggestion, created)`` where ``created`` is a
            boolean indicating if the suggestion was successfully added.
            If the suggestion already exists it's returned as well.
        """
        if not [_f for _f in translation if _f]:
            return (None, False)

        if translation == self.target:
            return (None, False)

        if user is None:
            User = get_user_model()
            user = User.objects.get_system_user()

        try:
            suggestion = Suggestion.objects.pending().get(
                unit=self, user=user, target_f=translation,
            )
            return (suggestion, False)
        except Suggestion.DoesNotExist:
            suggestion = Suggestion(
                unit=self,
                user=user,
                state=SuggestionStates.PENDING,
                creation_time=timezone.now(),
            )
            suggestion.target = translation
            suggestion.save()

            sub = Submission(
                creation_time=suggestion.creation_time,
                translation_project=self.store.translation_project,
                submitter=user,
                unit=self,
                store=self.store,
                type=SubmissionTypes.SUGG_ADD,
                suggestion=suggestion,
                similarity=similarity,
                mt_similarity=mt_similarity,
            )
            sub.save()

            self.store.mark_dirty(CachedMethods.SUGGESTIONS, CachedMethods.LAST_ACTION)
            if touch:
                self.save()

        return (suggestion, True)

    def accept_suggestion(self, suggestion, translation_project, reviewer):
        # Save for later
        old_state = self.state
        old_target = self.target

        # Update some basic attributes so we can create submissions. Note
        # these do not conflict with `ScoreLog`'s interests, so it's safe
        self.target = suggestion.target
        if self.state == FUZZY:
            self.state = TRANSLATED

        if suggestion.user_id is not None:
            suggestion_user = suggestion.user
        else:
            User = get_user_model()
            suggestion_user = User.objects.get_nobody_user()

        current_time = timezone.now()
        suggestion.state = SuggestionStates.ACCEPTED
        suggestion.reviewer = reviewer
        suggestion.review_time = current_time
        suggestion.save()

        create_subs = OrderedDict()
        if old_state != self.state:
            create_subs[SubmissionFields.STATE] = [old_state, self.state]
            self.store.mark_dirty(CachedMethods.WORDCOUNT_STATS)
        create_subs[SubmissionFields.TARGET] = [old_target, self.target]

        subs_created = []
        for field in create_subs:
            kwargs = {
                "creation_time": current_time,
                "translation_project": translation_project,
                "submitter": reviewer,
                "unit": self,
                "store": self.store,
                "field": field,
                "type": SubmissionTypes.SUGG_ACCEPT,
                "old_value": create_subs[field][0],
                "new_value": create_subs[field][1],
            }
            if field == SubmissionFields.TARGET:
                kwargs["suggestion"] = suggestion

            subs_created.append(Submission(**kwargs))
        if subs_created:
            self.submission_set.add(*subs_created, bulk=False)

        # FIXME: remove such a dependency on `ScoreLog`
        # Update current unit instance's attributes
        # important to set these attributes after saving Submission
        # because in the `ScoreLog` we need to access the unit's certain
        # attributes before it was saved
        self.submitted_by = suggestion_user
        self.submitted_on = current_time
        self.reviewed_by = reviewer
        self.reviewed_on = self.submitted_on
        self._log_user = reviewer

        self.store.mark_dirty(CachedMethods.SUGGESTIONS, CachedMethods.LAST_ACTION)
        # Update timestamp
        self.save()

    def reject_suggestion(self, suggestion, translation_project, reviewer):
        suggestion.state = SuggestionStates.REJECTED
        suggestion.review_time = timezone.now()
        suggestion.reviewer = reviewer
        suggestion.save()

        sub = Submission(
            creation_time=suggestion.review_time,
            translation_project=translation_project,
            submitter=reviewer,
            unit=self,
            store=self.store,
            type=SubmissionTypes.SUGG_REJECT,
            suggestion=suggestion,
        )
        sub.save()

        self.store.mark_dirty(CachedMethods.SUGGESTIONS, CachedMethods.LAST_ACTION)
        # Update timestamp
        self.save()

    def has_critical_checks(self):
        return self.qualitycheck_set.filter(category=Category.CRITICAL,).exists()

    def toggle_qualitycheck(self, check_id, false_positive, user):
        check = self.qualitycheck_set.get(id=check_id)

        if check.false_positive == false_positive:
            return

        check.false_positive = false_positive
        check.save()

        self.store.mark_dirty(CachedMethods.CHECKS, CachedMethods.LAST_ACTION)
        self._log_user = user
        if false_positive:
            self._save_action = MUTE_QUALITYCHECK
        else:
            self._save_action = UNMUTE_QUALITYCHECK

        # create submission
        if false_positive:
            sub_type = SubmissionTypes.MUTE_CHECK
        else:
            sub_type = SubmissionTypes.UNMUTE_CHECK

        sub = Submission(
            creation_time=timezone.now(),
            translation_project=self.store.translation_project,
            submitter=user,
            field=SubmissionFields.NONE,
            unit=self,
            store=self.store,
            type=sub_type,
            quality_check=check,
        )
        sub.save()

        # update timestamp
        # log user action
        self.save()

    def get_last_updated_info(self):
        return int(dateformat.format(self.creation_time, "U"))


# # # # # # # # # # #  Store # # # # # # # # # # # # # #


def validate_no_slashes(value):
    if "/" in value:
        raise ValidationError('Store name cannot contain "/" characters')

    if "\\" in value:
        raise ValidationError('Store name cannot contain "\\" characters')


# Needed to alter storage location in tests
fs = PootleFileSystemStorage()


class Store(models.Model, CachedTreeItem, base.TranslationStore):
    """A model representing a translation store (i.e. a PO or XLIFF file)."""

    UnitClass = Unit
    Name = "Model Store"

    file = TranslationStoreField(
        max_length=255, storage=fs, db_index=True, null=False, editable=False
    )

    parent = models.ForeignKey(
        "pootle_app.Directory",
        related_name="child_stores",
        db_index=True,
        editable=False,
        on_delete=models.CASCADE,
    )

    translation_project_fk = "pootle_translationproject.TranslationProject"
    translation_project = models.ForeignKey(
        translation_project_fk,
        related_name="stores",
        db_index=True,
        editable=False,
        on_delete=models.CASCADE,
    )

    # any changes to the `pootle_path` field may require updating the schema
    # see migration 0007_case_sensitive_schema.py
    pootle_path = models.CharField(
        max_length=255, null=False, unique=True, db_index=True, verbose_name=_("Path")
    )
    # any changes to the `name` field may require updating the schema
    # see migration 0007_case_sensitive_schema.py
    name = models.CharField(
        max_length=128, null=False, editable=False, validators=[validate_no_slashes]
    )

    file_mtime = models.IntegerField(null=False, default=0)
    state = models.IntegerField(null=False, default=NEW, editable=False, db_index=True)
    creation_time = models.DateTimeField(
        auto_now_add=True, db_index=True, editable=False, null=True
    )
    last_sync_revision = models.IntegerField(db_index=True, null=True, blank=True)
    obsolete = models.BooleanField(default=False)

    objects = StoreManager()
    simple_objects = models.Manager()

    class Meta(object):
        ordering = ["pootle_path"]
        unique_together = ("parent", "name")
        base_manager_name = "objects"

    # # # # # # # # # # # # # #  Properties # # # # # # # # # # # # # # # # # #

    @property
    def code(self):
        return self.name.replace(".", "-")

    @property
    def real_path(self):
        return self.file.name

    @property
    def units(self):
        return self.unit_set.filter(state__gt=OBSOLETE).order_by("index")

    @units.setter
    def units(self, value):
        """Null setter to avoid tracebacks if :meth:`TranslationStore.__init__`
        is called.
        """
        pass

    # # # # # # # # # # # # # #  Methods # # # # # # # # # # # # # # # # # # #

    @cached_property
    def path(self):
        """Returns just the path part omitting language and project codes.

        If the `pootle_path` of a :cls:`Store` object `store` is
        `/af/project/dir1/dir2/file.po`, `store.path` will return
        `dir1/dir2/file.po`.
        """
        return to_tp_relative_path(self.pootle_path)

    def __init__(self, *args, **kwargs):
        super(Store, self).__init__(*args, **kwargs)

    def __str__(self):
        return str(self.pootle_path)

    def save(self, *args, **kwargs):
        created = not self.id
        update_cache = kwargs.pop("update_cache", True)

        self.pootle_path = self.parent.pootle_path + self.name

        # Force validation of fields.
        self.full_clean()

        super(Store, self).save(*args, **kwargs)
        if created:
            store_log(
                user="system", action=STORE_ADDED, path=self.pootle_path, store=self.id
            )
        if update_cache:
            self.update_dirty_cache()

    def delete(self, *args, **kwargs):
        parent = self.get_parent()

        store_log(
            user="system", action=STORE_DELETED, path=self.pootle_path, store=self.id
        )

        lang = self.translation_project.language.code
        for unit in self.unit_set.iterator():
            action_log(
                user="system",
                action=UNIT_DELETED,
                lang=lang,
                unit=unit.id,
                translation="",
                path=self.pootle_path,
            )

        super(Store, self).delete(*args, **kwargs)

        self.clear_cache()
        if parent is not None:
            parent.update_all_cache()

    def makeobsolete(self):
        """Make this store and all its units obsolete."""
        store_log(
            user="system", action=STORE_OBSOLETE, path=self.pootle_path, store=self.id
        )

        lang = self.translation_project.language.code
        unit_query = self.unit_set.filter(state__gt=OBSOLETE)
        unit_ids = unit_query.values_list("id", flat=True)
        for unit_id in unit_ids:
            action_log(
                user="system",
                action=UNIT_OBSOLETE,
                lang=lang,
                unit=unit_id,
                translation="",
                path=self.pootle_path,
            )
        unit_query.update(state=OBSOLETE, index=0)
        self.obsolete = True
        self.save()
        self.clear_cache()

    def get_absolute_url(self):
        return reverse(
            "pootle-tp-store-browse", args=split_pootle_path(self.pootle_path)
        )

    def get_translate_url(self, **kwargs):
        return u"".join(
            [
                reverse(
                    "pootle-tp-store-translate",
                    args=split_pootle_path(self.pootle_path),
                ),
                get_editor_filter(**kwargs),
            ]
        )

    def findid_bulk(self, ids, unit_set=None):
        chunks = 200
        for i in range(0, len(ids), chunks):
            units = (unit_set or self.unit_set).filter(id__in=ids[i : i + chunks])
            for unit in units.iterator():
                yield unit

    def get_file_mtime(self):
        try:
            # Convert to int; there's no need for microsecond precision
            return int(self.file.getpomtime()[0])
        except (OSError, ValueError):
            return 0

    def update_index(self, start, delta):
        Unit.objects.filter(store_id=self.id, index__gte=start).update(
            index=operator.add(F("index"), delta)
        )

    def mark_units_obsolete(self, uids_to_obsolete, update_revision=None):
        """Marks a bulk of units as obsolete.

        :param uids_to_obsolete: UIDs of the units to be marked as obsolete.
        :return: The number of units marked as obsolete.
        """
        obsoleted = 0
        for unit in self.findid_bulk(uids_to_obsolete):
            # Use the same (parent) object since units will
            # accumulate the list of cache attributes to clear
            # in the parent Store object
            unit.store = self
            if not unit.isobsolete():
                unit.makeobsolete()
                unit.save(revision=update_revision)
                obsoleted += 1

        return obsoleted

    @cached_property
    def updater(self):
        return StoreUpdater(self)

    @cached_property
    def syncer(self):
        return PoStoreSyncer(self)

    def record_submissions(
        self, unit, old_target, old_state, current_time, user, submission_type=None
    ):
        """Records all applicable submissions for `unit`.

        EXTREME HAZARD: this relies on implicit `._<field>_updated` members
        being available in `unit`. Let's look into replacing such members with
        something saner (#3895).
        """
        create_subs = OrderedDict()

        # FIXME: extreme implicit hazard
        if unit._state_updated:
            create_subs[SubmissionFields.STATE] = [
                old_state,
                unit.state,
            ]

        # FIXME: extreme implicit hazard
        if unit._target_updated:
            create_subs[SubmissionFields.TARGET] = [
                old_target,
                unit.target_f,
            ]

        # FIXME: extreme implicit hazard
        if unit._comment_updated:
            create_subs[SubmissionFields.COMMENT] = [
                "",
                unit.translator_comment or "",
            ]

        if submission_type is None:
            submission_type = SubmissionTypes.SYSTEM

        subs_created = []
        for field in create_subs:
            subs_created.append(
                Submission(
                    creation_time=current_time,
                    translation_project_id=self.translation_project_id,
                    submitter=user,
                    unit=unit,
                    store_id=self.id,
                    field=field,
                    type=submission_type,
                    old_value=create_subs[field][0],
                    new_value=create_subs[field][1],
                )
            )
        if subs_created:
            unit.submission_set.add(*subs_created, bulk=False)

    def update(self, store, user=None, store_revision=None, submission_type=None):
        """Update DB with units from a ttk Store.

        :param store: a source `Store` instance from TTK.
        :param store_revision: revision at which the source `Store` was last
            synced.
        :param user: User to attribute updates to.
        :param submission_type: Submission type of saved updates.
        """
        self.updater.update(
            store,
            user=user,
            store_revision=store_revision,
            submission_type=submission_type,
        )

    def deserialize(self, data):
        buffered_data = io.BytesIO(data)
        buffered_data.name = self.name
        return getobject(buffered_data)

    def serialize(self):
        return bytes(self.syncer.convert())

    def sync(
        self,
        update_structure=False,
        conservative=True,
        user=None,
        skip_missing=False,
        only_newer=True,
    ):
        """Sync file with translations from DB."""
        if skip_missing and not self.file.exists():
            return

        self.syncer.sync(
            update_structure=update_structure,
            conservative=conservative,
            user=user,
            only_newer=only_newer,
        )

    # # # # # # # # # # # #  TranslationStore # # # # # # # # # # # # #

    suggestions_in_format = True

    def max_index(self):
        """Largest unit index"""
        return max_column(self.unit_set.all(), "index", -1)

    def addunit(self, unit, index=None, user=None, update_revision=None):
        if index is None:
            index = self.max_index() + 1

        newunit = self.UnitClass(store=self, index=index)
        newunit.update(unit, user=user)
        if newunit._target_updated or newunit.istranslated():
            newunit.submitted_by = user
            newunit.submitted_on = timezone.now()

        if self.id:
            newunit.save(revision=update_revision, user=user)
        return newunit

    def findunits(self, source, obsolete=False):
        if not obsolete and hasattr(self, "sourceindex"):
            return super(Store, self).findunits(source)

        # find using hash instead of index
        source_hash = md5(source.encode("utf-8")).hexdigest()
        units = self.unit_set.filter(source_hash=source_hash)
        if obsolete:
            units = units.filter(state=OBSOLETE)
        else:
            units = units.filter(state__gt=OBSOLETE)
        if units.count():
            return units

    def findunit(self, source, obsolete=False):
        units = self.findunits(source, obsolete)
        if units:
            return units[0]

    def findid(self, id):
        if hasattr(self, "id_index"):
            return self.id_index.get(id, None)

        unitid_hash = md5(id.encode("utf-8")).hexdigest()
        try:
            return self.unit_set.get(unitid_hash=unitid_hash)
        except Unit.DoesNotExist:
            return None

    def header(self):
        # FIXME: we should store some metadata in db
        if self.file and hasattr(self.file.store, "header"):
            return self.file.store.header()

    def get_max_unit_revision(self):
        return max_column(self.unit_set.all(), "revision", 0)

    # # # TreeItem
    def can_be_updated(self):
        return not self.obsolete

    def get_parent(self):
        if self.parent.is_translationproject():
            return self.translation_project
        return self.parent

    def _get_wordcount_stats(self):
        """calculate full wordcount statistics"""
        ret = {"total": 0, "translated": 0, "fuzzy": 0}

        # XXX: `order_by()` here is important as it removes the default
        # ordering for units. See #3897 for reference.
        res = (
            self.units.order_by()
            .values("state")
            .annotate(wordcount=models.Sum("source_wordcount"))
        )
        for item in res:
            ret["total"] += item["wordcount"]
            if item["state"] == TRANSLATED:
                ret["translated"] = item["wordcount"]
            elif item["state"] == FUZZY:
                ret["fuzzy"] = item["wordcount"]

        return ret

    def _get_checks(self):
        try:
            queryset = QualityCheck.objects.filter(
                unit__store=self, unit__state__gt=UNTRANSLATED, false_positive=False
            )

            queryset = queryset.values("unit", "name", "category").order_by(
                "unit", "-category"
            )

            saved_unit = None
            result = {
                "unit_critical_error_count": 0,
                "checks": {},
            }
            for item in queryset:
                if item["unit"] != saved_unit or saved_unit is None:
                    saved_unit = item["unit"]
                    if item["category"] == Category.CRITICAL:
                        result["unit_critical_error_count"] += 1
                if item["name"] in result["checks"]:
                    result["checks"][item["name"]] += 1
                else:
                    result["checks"][item["name"]] = 1

            return result
        except Exception as e:
            logging.info(u"Error getting quality checks for %s\n%s", self.name, e)
            return {}

    def _get_mtime(self):
        return max_column(self.unit_set.all(), "mtime", datetime_min)

    def _get_last_updated(self):
        try:
            max_unit = self.unit_set.all().order_by("-creation_time")[0]
        except IndexError:
            max_unit = None

        # creation_time field has been added recently, so it can have NULL
        # value
        if max_unit is not None:
            max_time = max_unit.creation_time
            if max_time:
                return max_unit.get_last_updated_info()

        return CachedTreeItem._get_last_updated()

    def _get_last_action(self, submission=None):
        if submission is None:
            try:
                sub = (
                    Submission.simple_objects.filter(store=self)
                    .exclude(type=SubmissionTypes.UNIT_CREATE)
                    .latest()
                )
            except Submission.DoesNotExist:
                return CachedTreeItem._get_last_action()
        else:
            sub = submission

        return sub.get_submission_info()

    def _get_suggestion_count(self):
        """Check if any unit in the store has suggestions"""
        return Suggestion.objects.filter(
            unit__store=self, unit__state__gt=OBSOLETE, state=SuggestionStates.PENDING
        ).count()

    def all_pootle_paths(self):
        """Get cache_key for all parents (to the Language and Project)
        of current TreeItem
        """
        return super(Store, self).all_pootle_paths()

    # # # /TreeItem


# # # # # # # # # # # # # # # #  Translation # # # # # # # # # # # # # # #
