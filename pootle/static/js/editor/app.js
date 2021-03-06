/*
 * Copyright (C) Pootle contributors.
 * Copyright (C) Zing contributors.
 *
 * This file is a part of the Zing project. It is distributed under the GPL3
 * or later license. See the LICENSE file for a copy of the license and the
 * AUTHORS file for copyright and authorship information.
 */

import $ from 'jquery';
import _ from 'underscore';
import React from 'react';
import ReactDOM from 'react-dom';

import TimeSince from 'components/TimeSince';
import ReactRenderer from 'utils/ReactRenderer';

// jQuery plugins
import 'jquery-bidi';
import 'jquery-easing';
import 'jquery-highlightRegex';
import 'jquery-history';
import 'jquery-serializeObject';
import 'jquery-utils';

// Other plugins
import cx from 'classnames';
import Levenshtein from 'levenshtein';
import mousetrap from 'mousetrap';

import StatsAPI from 'api/StatsAPI';
import UnitAPI from 'api/UnitAPI';
import diff from 'utils/diff';
import { q, qAll } from 'utils/dom';
import { nt, t } from 'utils/i18n';
import linkHashtags from 'utils/linkHashtags';

import SimilarTranslationList from './components/SimilarTranslationList';
import SuggestionFeedbackForm from './components/SuggestionFeedbackForm';

import helpers from '../helpers';
import msg from '../msg';
import score from '../score';
import search from '../search';
import utils from '../utils';
import {
  decodeEntities, escapeUnsafeRegexSymbols, getAreaId, makeRegexForMultipleWords,
} from './utils';

import ReactEditor from './index';
import UnitList from './UnitList';

// Make the react-based editor available to templates. Long term, `index` would
// be the actual entry point, entirely superseding the `app` module.
PTL.reactEditor = ReactEditor;

const ALLOWED_SORTS = ['oldest', 'newest', 'default'];
const SHOW_CONTEXT_ROWS_TIMEOUT = 200;
const HIDE_CONTEXT_ROWS_TIMEOUT = 50;
const ADJUST_GEOMETRY_DELAY = 100;

const filterSelectOpts = {
  dropdownAutoWidth: true,
  dropdownCssClass: 'checks-dropdown',
  width: 'off',
};
const sortSelectOpts = Object.assign({
  minimumResultsForSearch: -1,
}, filterSelectOpts);


const mtProviders = [];


function highlightSuggestionsDiff(unit) {
  qAll('.js-suggestion-text').forEach(
    (translationTextNode) => {
      // eslint-disable-next-line no-param-reassign
      translationTextNode.innerHTML = diff(unit.targetText()[0],
                                           translationTextNode.dataset.string);
    }
  );
}


function _refreshChecksSnippet(newChecks) {
  const $checks = $('.js-unit-checks');
  const focusedArea = $('.focusthis')[0];

  $checks.html(newChecks).show();
  utils.blinkClass($checks, 'blink', 4, 200);
  focusedArea.focus();
}


window.PTL = window.PTL || {};


PTL.editor = {

  /* Initializes the editor */
  init(options) {
    /* Default settings */
    this.settings = {
      mt: [],
    };

    if (options) {
      Object.assign(this.settings, options);
    }

    /* Cached elements */
    this.$editor = $('#editor');
    this.$editorActivity = $('#js-editor-act');
    this.$viewRowsBefore = $('.js-view-rows-before');
    this.$contextRowsBefore = $('.js-context-rows-before');
    this.$editRowWrapper = $('.js-edit-row-wrapper');
    this.$editorRow = $('.js-editor-row');
    this.$viewRowsAfter = $('.js-view-rows-after');
    this.$contextRowsAfter = $('.js-context-rows-after');
    this.editorTableEl = q('.js-editor-table');
    this.$filterStatus = $('#js-filter-status');
    this.$filterChecks = $('#js-filter-checks');
    this.$filterChecksWrapper = $('.js-filter-checks-wrapper');
    this.$filterSortBy = $('#js-filter-sort');
    this.$navNext = $('#js-nav-next');
    this.$navPrev = $('#js-nav-prev');
    this.unitPositionEl = q('.js-unit-position');
    this.unitCountEl = q('.js-unit-count');

    /* Initialize variables */

    this.filter = 'all';
    this.checks = [];
    this.sortBy = 'default';
    this.user = null;
    this.preventNavigation = false;
    this.isUnitDirty = false;
    this.editorIsClosed = false;
    this.contextTimer = null;
    this.lastFilter = null;

    this.units = new UnitList({
      onUnitChange: uid => this.handleUnitChange(uid),
      onContextData: (uid, ctx) => this.handleContextData(uid, ctx),
      onFetchError: (xhr, status) => this.error(xhr, status),
    });

    // Preview window
    this.previewWindow = null;
    this.currentPreviewLink = null;

    this.isLoading = true;
    this.showActivity();

    /* Levenshtein word comparer */
    this.wordComparer = new Levenshtein({ compare: 'words' });

    /* Compile templates */
    this.tmpl = {
      vUnit: _.template($('#view_unit').html()),
    };

    /* Initialize search */
    search.init({
      onSearch: this.onSearch,
    });

    /* Select2 */
    this.$filterStatus.select2(filterSelectOpts);
    this.$filterSortBy.select2(sortSelectOpts);

    /* Screenshot images */
    this.$editor.on('click', '.js-dev-img', function displayScreenshot(e) {
      e.preventDefault();

      $(this).magnificPopup({
        type: 'image',
        gallery: {
          enabled: true,
        },
      }).magnificPopup('open');
    });

    /*
     * Bind event handlers
     */
    $(window).on('resize', () => this.handleWindowResize());

    /* Editor toolbar navigation/search/filtering */
    $('#toolbar').on('click', '#js-nav-prev', () => this.gotoPrev());
    $('#toolbar').on('click', '#js-nav-next', () => this.gotoNext());
    $('#toolbar').on('change', '#js-filter-sort', () => this.filterSort());

    /* Filtering */
    $('#actions').on('change', '#js-filter-status', () => this.filterStatus());
    $('#actions').on('change', '#js-filter-checks', () => this.filterChecks());

    /* State changes */
    this.$editor.on('change', 'input.fuzzycheck',
      () => this.onStateChange());
    this.$editor.on('click', 'input.fuzzycheck',
      () => this.onStateClick());
    this.$editor.on('input', '#id_translator_comment',
      () => this.handleTranslationChange());

    /* Context row preview */
    this.$editor.on('mouseover', '.js-show-context-rows',
      (e) => this.handleContextPreviewMouseover(e));
    this.$editor.on('mouseout', '.js-show-context-rows',
      (e) => this.handleContextPreviewMouseout(e));

    /* Suggest / submit */
    this.$editor.on('click', '.switch-suggest-mode a',
      (e) => this.toggleSuggestMode(e));

    /* Update focus when appropriate */
    this.$editor.on('focus', '.focusthis', (e) => {
      PTL.editor.focused = e.target;
    });
    this.$editor.on('focus', '.js-translation-area', (e) => {
      $(e.target).closest('.js-editor-area-wrapper').addClass('is-focused');
    });
    this.$editor.on('blur', '.js-translation-area', (e) => {
      $(e.target).closest('.js-editor-area-wrapper').removeClass('is-focused');
    });

    /* Write TM results, special chars... into the currently focused element */
    this.$editor.on('click', '.js-editor-copytext', (e) => this.copyText(e));
    this.$editor.on('click', '.js-editor-copy-tm-text', (e) => this.copyTMText(e));

    /* Copy translator comment */
    this.$editor.on('click', '.js-editor-copy-comment', (e) => {
      const text = e.currentTarget.dataset.string;
      this.copyComment(text);
    });

    /* Copy original translation */
    this.$editor.on('click', '.js-copyoriginal', (e) => {
      this.copyOriginal(e.currentTarget.dataset.languageCode);
    });

    /* Editor navigation/submission */
    this.$editor.on('mouseup', 'tr.view-row', this.gotoUnit);
    this.$editor.on('click', 'input.submit', (e) => {
      e.preventDefault();
      this.handleSubmit();
    });
    this.$editor.on('click', 'input.suggest', (e) => {
      e.preventDefault();
      this.handleSuggest();
    });
    this.$editor.on('click', '.js-suggestion-reject', (e) => {
      e.stopPropagation();
      this.rejectSuggestion(e.currentTarget.dataset.suggId);
    });
    this.$editor.on('click', '.js-suggestion-accept', (e) => {
      e.stopPropagation();
      this.acceptSuggestion(e.currentTarget.dataset.suggId);
    });
    this.$editor.on('click', '.js-suggestion-toggle',
      (e) => this.toggleSuggestion(e, { canHide: true }));

    if (this.settings.canReview) {
      this.$editor.on('click', '.js-user-suggestion',
        (e) => this.toggleSuggestion(e, { canHide: false }));
    }

    this.$editor.on('click', '.js-translate-lightbox', () => this.closeSuggestion());

    this.$editor.on('click', '#js-toggle-timeline', (e) => this.toggleTimeline(e));
    this.$editor.on('click', '.js-toggle-check', (e) => {
      this.toggleCheck(e.currentTarget.dataset.checkId);
    });

    /* Commenting */
    this.$editor.on('click', '.js-editor-comment', (e) => {
      e.preventDefault();
      const $elem = $('.js-editor-comment-form');
      const $comment = $('.js-editor-comment');
      $comment.toggleClass('selected');
      if ($comment.hasClass('selected')) {
        $elem.css('display', 'inline-block');
        $('#id_translator_comment').focus();
      } else {
        $elem.css('display', 'none');
      }
      this.adjustEditorGeometry();
    });
    this.$editor.on('submit', '#js-comment-form', (e) => this.addComment(e));
    this.$editor.on('click', '.js-comment-remove', (e) => this.removeComment(e));

    /* Misc */
    this.$editor.on('click', '.js-toggle-raw', (e) => {
      e.preventDefault();
      $('.js-translate-translation').toggleClass('raw');
      const toggle = document.querySelector('.js-toggle-raw');
      toggle.classList.toggle('selected');
      ReactEditor.setProps({ isRawMode: toggle.classList.contains('selected') });
      this.adjustEditorGeometry();
    });

    /* Confirmation prompt */
    window.addEventListener('beforeunload', (e) => {
      if (PTL.editor.isUnitDirty || PTL.editor.isSuggestionFeedbackFormDirty) {
        // eslint-disable-next-line no-param-reassign
        e.returnValue = t(
          'You have unsaved changes in this string. Navigating away will discard those changes.'
        );
      }
    });

    /* Preview windows */
    window.addEventListener('message', (e) => {
      if (!e.data) {
        return;
      }

      if (e.data.navigationHandled) {
        clearTimeout(this.openLinkTimeout);
      }
    });
    this.$editor.on('click', 'a[target="_preview"]', (e) => {
      e.preventDefault();
      this.openPreviewLink(e.target);
    });

    /* Bind hotkeys */
    const hotkeys = mousetrap(document.body);

    // FIXME: move binding to `SuggestionFeedbackForm` component
    hotkeys.bind('esc', (e) => {
      e.preventDefault();
      if (this.selectedSuggestionId !== undefined) {
        this.closeSuggestion();
        return;
      }
      this.hideContextRows();
    });
    // Leave 'ctrl+return' for backward compatibility with Mac
    hotkeys.bind(['mod+return', 'ctrl+return'], (e) => {
      e.preventDefault();
      if (this.isSuggestMode()) {
        this.handleSuggest();
      } else {
        this.handleSubmit();
      }
    });
    hotkeys.bind(['mod+/', 'ctrl+space'], (e) => {
      e.preventDefault();
      this.toggleState();
    });
    hotkeys.bind('ctrl+shift+space', (e) => {
      e.preventDefault();
      this.toggleSuggestMode(e);
    });

    hotkeys.bind(['mod+up', 'ctrl+,'], (e) => {
      e.preventDefault();
      this.gotoPrev();
    });
    hotkeys.bind(['mod+down', 'ctrl+.'], (e) => {
      e.preventDefault();
      this.gotoNext({ isSubmission: false });
    });

    hotkeys.bind(['ctrl+alt+c'], (e) => {
      e.preventDefault();
      const sources = qAll('.js-copyoriginal');
      const languageCode = sources[sources.length - 1].dataset.languageCode;
      this.copyOriginal(languageCode);
    });

    /* XHR activity indicator */
    $(document).ajaxStart(() => {
      clearTimeout(this.delayedActivityTimer);
      if (this.isLoading) {
        return;
      }

      this.delayedActivityTimer = setTimeout(() => {
        this.showActivity();
      }, 3000);
    });
    $(document).ajaxStop(() => {
      clearTimeout(this.delayedActivityTimer);
      if (!this.isLoading) {
        this.hideActivity();
      }
    });

    /* Load MT providers */
    this.settings.mt.forEach((provider) => {
      require.ensure([], () => {
        // Retrieve actual module name: FOO_BAR_BAZ => FooBarBaz
        const moduleName = provider.name.split('_').map(
          (x) => x[0] + x.slice(1).toLowerCase()
        ).join('');
        // Webpack doesn't like template strings for now...
        // eslint-disable-next-line prefer-template
        const Module = require('./mt/providers/' + moduleName).default;
        mtProviders.push(new Module(provider.key));
      });
    });

    /* History support */
    $.history.init((hash) => {
      const params = utils.getParsedHash(hash);

      if (this.selectedSuggestionId !== undefined) {
        this.closeSuggestion({ checkIfCanNavigate: false });
      }

      // get filter criteria (hash without the 'unit' part)
      const filterHash = utils.updateHashPart(undefined, undefined, ['unit'], hash);
      if (filterHash === this.lastFilter) {
        // if filter criteria are the same, first ensure back/forward buttons
        // work when unit was specified
        const unit = params.unit ? parseInt(params.unit, 10) : null;
        if (unit) {
          this.units.goto(unit);
        }
        // otherwise, if units have already been loaded, exit early...
        if (this.units.length > 0) {
          return;
        }
      }
      // ...otherwise, save the filter value for later comparison continue
      // through the filters and prepare the query to download the units
      this.lastFilter = filterHash;

      // Reset to defaults
      this.filter = 'all';
      this.checks = [];
      this.category = undefined;
      this.sortBy = 'default';

      const filterName = params.filter || 'all';

      // Set current state
      this.filter = filterName;

      if (this.filter === 'checks') {
        if ('checks' in params) {
          this.checks = params.checks.split(',');
        } else if ('category' in params) {
          this.category = params.category;
        }
        this.getCheckOptions();
      }
      if ('sort' in params) {
        const { sort } = params;
        this.sortBy = ALLOWED_SORTS.indexOf(sort) !== -1 ? sort : 'default';
      }

      if ('month' in params) {
        this.month = params.month;
      } else {
        this.month = null;
      }

      // Only accept the user parameter for 'user-*' filters
      if ('user' in params && this.filter.indexOf('user-') === 0) {
        this.user = encodeURIComponent(params.user);
        const user = this.user;

        const values = {
          'user-suggestions':
            // Translators: '%s' is a username
            t("%(user)s's pending suggestions", { user }),
          'user-suggestions-accepted':
            // Translators: '%s' is a username
            t("%(user)s's accepted suggestions", { user }),
          'user-suggestions-rejected':
            // Translators: '%s' is a username
            t("%(user)s's rejected suggestions", { user }),
          'user-submissions':
            // Translators: '%s' is a username
            t("%(user)s's submissions", { user }),
          'user-submissions-overwritten':
            // Translators: '%s' is a username, meaning "submissions by %s,
            // that were overwritten"
            t("%(user)s's overwritten submissions", { user }),
        };
        const newOpts = [];
        for (const key in values) {
          if (!values.hasOwnProperty(key)) {
            continue;
          }
          newOpts.push(`
            <option value="${key}" data-user="${user}" class="js-user-filter">
              ${values[key]}
            </option>
          `);
        }
        $('.js-user-filter').remove();
        this.$filterStatus.append(newOpts.join(''));
      }

      if ('search' in params) {
        // Note that currently the search, if provided along with the other
        // filters, would override them
        this.filter = 'search';

        const newState = {
          searchText: params.search,
        };

        if ('sfields' in params) {
          newState.searchFields = params.sfields.split(',');
        }
        if ('soptions' in params) {
          newState.searchOptions = params.soptions.split(',');
        }

        search.setState(newState);
      }

      // Update the filter UI to match the current filter

      // disable navigation on UI toolbar events to prevent data reload
      this.preventNavigation = true;

      const filterValue = this.filter === 'search' ? 'all' : this.filter;
      this.$filterStatus.select2('val', filterValue);

      if (this.filter === 'checks') {
        this.$filterChecksWrapper.css('display', 'inline-block');
        const selectedValue = this.category || this.checks[0] || 'all';
        this.$filterChecks.select2(filterSelectOpts).select2('val', selectedValue);
      } else {
        this.$filterChecksWrapper.hide();
      }

      this.$filterSortBy.select2('val', this.sortBy);

      // re-enable normal event handling
      this.preventNavigation = false;

      // get all the uids and see if the uId is in the list
      const reqData = {
        path: this.settings.pootlePath,
      };
      Object.assign(reqData, this.getReqData());

      if (params.unit) {
        reqData.uid = parseInt(params.unit, 10);
      }
      this.units.fetchUids(reqData).done((hasResults) => {
        if (!hasResults) {
          this.handleNoMatchingUnitsFound({ filter: this.filter });
        } else {
          this.units.goto(reqData.uid || this.units.uids[0]);
          if (this.units.idx === -1) {
            this.handleUnitNotFound({ filter: this.filter });
          }
        }
      });
    }, { unescape: true });
  },

  /* Stuff to be done when the editor is ready  */
  ready() {
    if (this.units.unit.is_obsolete) {
      this.displayObsoleteMsg();
    }

    highlightSuggestionsDiff(this.units.unit);

    // set direction of the comment body
    $('.extra-item-comment').filter(':not([dir])').bidi();
    // set direction of the suggestion body
    $('.suggestion-translation').filter(':not([dir])').bidi();

    const $devComments = $('.js-developer-comments');
    $devComments.html(linkHashtags($devComments.html()));

    if (this.previewWindow && !this.previewWindow.closed) {
      const previewLinks = qAll('a[target="_preview"]');
      if (previewLinks.length) {
        this.openPreviewLink(previewLinks[0]);
      }
    }

    if (this.filter === 'search') {
      this.hlSearch({ rowType: 'edit' });
      this.hlSearch({ rowType: 'view' });
    }

    const tmResults = this.units.unit.tm_suggestions;
    if (tmResults.length) {
      const sourceText = this.units.unit.sourceText()[0];
      const bestResult = tmResults[0];
      this.populateWithPerfectMatch(bestResult, sourceText);

      ReactRenderer.render(
        <SimilarTranslationList
          originalSource={sourceText}
          results={tmResults}
          sourceLang={this.units.unit.sourceLang}
          targetLang={this.units.unit.targetLang}
        />,
        q('.js-mnt-tm')
      );
    }

    this.runHooks();

    this.isUnitDirty = false;
    this.keepState = false;
    this.isLoading = false;
    this.hideActivity();
    this.updateExportLink();
    helpers.updateRelativeDates();

    this.adjustEditorGeometry();
  },

  canNavigate() {
    if (this.isUnitDirty || this.isSuggestionFeedbackFormDirty) {
      return window.confirm(  // eslint-disable-line no-alert
        t(
          'You have unsaved changes in this string. Navigating away will discard those changes.'
        )
      );
    }

    return true;
  },


  /*
   * Text utils
   */

  /* Highlights search results */
  hlSearch({ rowType }) {
    const { searchText, searchFields, searchOptions } = search.state;
    const selMap = {
      edit: {
        locations: '.js-unit-locations',
        notes: '.js-developer-comments',
        source: '.original .js-translation-text',
      },
      view: {
        source: '.js-view-original',
        target: '.js-view-translation',
      },
    };

    // Build highlighting selector based on chosen search fields
    const selectors = selMap[rowType];
    const sel = searchFields
      .filter(fieldName => selectors.hasOwnProperty(fieldName))
      .map(fieldName => selectors[fieldName]);
    if (!sel.length) {
      return;
    }

    let hlRegex;
    if (searchOptions.indexOf('exact') >= 0) {
      hlRegex = new RegExp(`(${escapeUnsafeRegexSymbols(searchText)})`);
    } else {
      hlRegex = new RegExp(makeRegexForMultipleWords(searchText), 'i');
    }
    $(sel.join(', ')).highlightRegex(hlRegex);
  },


  /* Copies text into the focused textarea */
  copyText(e) {
    const $el = $(e.currentTarget);
    const action = $el.data('action');
    const text = (
      $el.data('codepoint') && JSON.parse(`"${$el.data('codepoint')}"`) ||
      $el.data('string') ||
      $el.data('translation-aid') ||
      $el.text()
    );

    if (action === 'overwrite') {
      ReactEditor.setValueFor(this.focused || 0, text);
    } else {
      ReactEditor.insertAtCaretFor(this.focused || 0, text);
    }
  },

  copyTMText(e) {
    // Don't do anything if we're selecting text
    if (window.getSelection().toString() !== '') {
      return;
    }
    this.copyText(e);
  },


  /* Copies source text(s) into the target textarea(s)*/
  copyOriginal(languageCode) {
    const sources = this.units.unit.sources[languageCode];
    for (let i = 0; i < sources.length; i++) {
      ReactEditor.setValueFor(i, sources[i]);
    }

    this.goFuzzy();
  },

  copyComment(text) {
    const comment = q('.js-editor-comment');
    const commentForm = q('.js-editor-comment-form');
    const commentInput = q('#id_translator_comment');

    if (!comment.classList.contains('selected')) {
      commentForm.style.display = 'inline-block';
      comment.classList.add('selected');
    }

    commentInput.focus();
    commentInput.value = text;
  },

  /*
   * Fuzzying / unfuzzying functions
   */

  /* Sets the current unit's styling as fuzzy */
  doFuzzyStyle() {
    $('tr.edit-row').addClass('fuzzy-unit');
  },


  /* Unsets the current unit's styling as fuzzy */
  undoFuzzyStyle() {
    $('tr.edit-row').removeClass('fuzzy-unit');
  },


  /* Checks the current unit's fuzzy checkbox */
  doFuzzyBox() {
    const $checkbox = $('input.fuzzycheck');
    $checkbox.prop('checked', true);

    if (!this.settings.isAdmin) {
      if (!this.isSuggestMode()) {
        $('.js-fuzzy-block').show();
      }
      $checkbox[0].defaultChecked = true;
    }

    $checkbox.trigger('change');
  },


  /* Unchecks the current unit's fuzzy checkbox */
  undoFuzzyBox() {
    const $checkbox = $('input.fuzzycheck');
    $checkbox.prop('checked', false);
    $checkbox.trigger('change');
  },


  /* Sets the current unit status as fuzzy (both styling and checkbox) */
  goFuzzy() {
    if (!this.isFuzzy()) {
      this.doFuzzyStyle();
      this.doFuzzyBox();
    }
  },


  /* Unsets the current unit status as fuzzy (both styling and checkbox) */
  ungoFuzzy() {
    if (this.isFuzzy()) {
      this.undoFuzzyStyle();
      this.undoFuzzyBox();
    }
  },


  /* Returns whether the current unit is fuzzy or not */
  isFuzzy() {
    return $('input.fuzzycheck').prop('checked');
  },

  toggleFuzzyStyle() {
    if (this.isFuzzy()) {
      this.doFuzzyStyle();
    } else {
      this.undoFuzzyStyle();
    }
  },

  toggleState() {
    // `blur()` prevents a double-click effect if the checkbox was
    // previously clicked using the mouse
    $('input.fuzzycheck:visible').blur().click();
  },

  /* Updates unit textarea and input's `default*` values. */
  updateUnitDefaultProperties() {
    ReactEditor.setProps({ initialValues: ReactEditor.stateValues.slice() });

    const checkbox = q('#id_state');
    checkbox.defaultChecked = checkbox.checked;
    this.handleTranslationChange();
  },

  /* Updates comment area's `defaultValue` value. */
  updateCommentDefaultProperties() {
    const comment = q('#id_translator_comment');
    comment.defaultValue = comment.value;
    this.handleTranslationChange();
  },

  handleTranslationChange() {
    const comment = q('#id_translator_comment');
    const commentChanged = comment !== null ?
                           comment.value !== comment.defaultValue : false;

    const submit = q('.js-submit');
    const suggest = q('.js-suggest');
    const suggestions = $('.js-user-suggestion').map(function getSuggestions() {
      return $(this).data('translation-aid');
    }).get();
    const checkbox = q('#id_state');
    const stateChanged = checkbox.defaultChecked !== checkbox.checked;

    let needsReview = false;
    let suggestionExists = false;

    // Non-admin users are required to clear the fuzzy checkbox
    if (!this.settings.isAdmin) {
      needsReview = checkbox.checked === true;
    }

    const areaChanged = this.isTextareaValueDirty();

    const valueState = ReactEditor.stateValues;
    if (suggestions.length) {
      for (let i = 0; i < valueState.length && !suggestionExists; i++) {
        suggestionExists = suggestions.indexOf(valueState[i]) !== -1;
      }
    }

    // Store dirty state for the current unit
    this.isUnitDirty = areaChanged || stateChanged || commentChanged;

    if (submit !== null) {
      submit.disabled = !(stateChanged || areaChanged) || needsReview;
    }
    if (suggest !== null) {
      suggest.disabled = !areaChanged || suggestionExists;
    }

    this.adjustEditorGeometry();
  },

  onStateChange() {
    this.handleTranslationChange();

    this.toggleFuzzyStyle();
  },

  onStateClick() {
    // Prevent automatic unfuzzying on explicit user action
    this.keepState = true;
  },

  onTextareaChange() {
    this.handleTranslationChange();

    if (this.isTextareaValueDirty() && !this.keepState) {
      this.ungoFuzzy();
    }

    clearTimeout(this.similarityTimer);
    this.similarityTimer = setTimeout(() => {
      this.checkSimilarTranslations();
      this.similarityTimer = null;  // So we know the code was run
    }, 200);
  },

  isTextareaValueDirty() {
    return !_.isEqual(ReactEditor.props.initialValues,
                      ReactEditor.stateValues);
  },


  /*
   * Translation's similarity
   */

  getSimilarityData() {
    const currentUnit = this.units.unit;
    return {
      similarity: currentUnit.similarityHuman,
      mt_similarity: currentUnit.similarityMT,
    };
  },

  calculateSimilarity(newTranslation, $elements, dataSelector) {
    let maxSimilarity = 0;
    let boxId = null;

    for (let i = 0; i < $elements.length; i++) {
      const $element = $elements.eq(i);
      const aidText = $element.data(dataSelector);
      const similarity = this.wordComparer.similarity(newTranslation, aidText);

      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        boxId = $element.hasClass('js-translation-area') ?
                null : $element.val('id');
      }
    }

    return {
      boxId,
      max: maxSimilarity,
    };
  },

  checkSimilarTranslations() {
    const dataSelector = 'translation-aid';
    const dataSelectorMT = 'translation-aid-mt';
    const $aidElementsMT = $(`[data-${dataSelectorMT}]`);

    let aidElementsSelector = `[data-${dataSelector}]`;

    // Exclude own suggestions for non-anonymous users
    if (!this.settings.isAnonymous) {
      aidElementsSelector += `[data-suggestor-id!=${this.settings.userId}]`;
    }

    const $aidElements = $(aidElementsSelector);

    if (!$aidElements.length && !$aidElementsMT.length) {
      return false;
    }

    const newTranslation = ReactEditor.stateValues[0];
    let simHuman = { max: 0, boxId: null };
    let simMT = { max: 0, boxId: null };

    if ($aidElements.length) {
      simHuman = this.calculateSimilarity(newTranslation, $aidElements,
                                          dataSelector);
    }
    if ($aidElementsMT.length) {
      simMT = this.calculateSimilarity(newTranslation, $aidElementsMT,
                                       dataSelectorMT);
    }

    this.units.unit.similarityHuman = simHuman.max;
    this.units.unit.similarityMT = simMT.max;

    const similarity = (simHuman.max > simMT.max) ? simHuman : simMT;
    this.highlightBox(similarity.boxId, similarity.max === 1);
    return true;
  },

  /* Applies highlight classes to `boxId`. */
  highlightBox(boxId, isExact) {
    const bestMatchCls = 'best-match';
    const exactMatchCls = 'exact-match';

    $('.translate-table').find(`.${bestMatchCls}`)
                         .removeClass(`${bestMatchCls} ${exactMatchCls}`);

    if (boxId === null) {
      return false;
    }

    $(boxId).addClass(cx({
      [bestMatchCls]: true,
      [exactMatchCls]: isExact,
    }));
    return true;
  },


  /*
   * Suggest / submit mode functions
   */

  /* Changes the editor into suggest mode */
  doSuggestMode() {
    this.editorTableEl.classList.add('suggest-mode');
  },


  /* Changes the editor into submit mode */
  undoSuggestMode() {
    this.editorTableEl.classList.remove('suggest-mode');
  },


  /* Returns true if the editor is in suggest mode */
  isSuggestMode() {
    return this.editorTableEl.classList.contains('suggest-mode');
  },


  /* Toggles suggest/submit modes */
  toggleSuggestMode(e) {
    e.preventDefault();
    if (this.isSuggestMode()) {
      this.undoSuggestMode();
    } else {
      this.doSuggestMode();
    }
  },

  updateExportLink() {
    const $exportOpt = $('.js-export-view');
    const baseUrl = $exportOpt.data('export-url');
    const hash = utils.getHash().replace(/&?unit=\d+/, '');
    const exportLink = hash ? `${baseUrl}?${hash}` : baseUrl;

    $exportOpt.data('href', exportLink);
  },

  /*
   * Indicators, messages, error handling
   */

  showActivity() {
    this.$editorActivity.spin().fadeIn(300);
  },

  hideActivity() {
    this.$editorActivity.spin(false).fadeOut(300);
  },

  /* Displays error messages on top of the toolbar */
  displayError(text) {
    this.hideActivity();
    msg.show({ text, level: 'error' });
  },


  /* Handles XHR errors */
  error(xhr, s) {
    let text = '';

    if (s === 'abort') {
      return;
    }

    if (xhr.status === 0) {
      text = t('Error while connecting to the server');
    } else if (xhr.status === 404) {
      text = t('Not found');
    } else if (xhr.status === 500) {
      text = t('Server error');
    } else if (s === 'timeout') {
      text = t('The server seems down. Try again later.');
    } else {
      text = $.parseJSON(xhr.responseText).msg;
    }

    PTL.editor.displayError(text);
  },

  lockEditor(message) {
    const editorBody = q('.js-editor-cell');
    editorBody.classList.add('unit-locked');

    q('.js-unit-locked-message').textContent = message;
    q('.js-editor-area-wrapper').classList.add('is-disabled');
    q('.js-translation-area').setAttribute('disabled', 'disabled');
  },

  displayObsoleteMsg() {
    this.lockEditor(t('This string no longer exists.'));
  },

  /*
   * Misc functions
   */

  /* Gets common request data */
  getReqData() {
    const reqData = {};

    if (this.filter === 'checks' && this.checks.length) {
      reqData.checks = this.checks.join(',');
    }
    if (this.filter === 'checks' && this.category) {
      reqData.category = this.category;
    }


    if (this.filter === 'search') {
      const { searchText, searchFields, searchOptions } = search.state;
      reqData.search = searchText;
      reqData.sfields = searchFields;
      reqData.soptions = searchOptions;
    } else {
      reqData.filter = this.filter;
      if (this.sortBy !== 'default') {
        reqData.sort = this.sortBy;
      }
    }

    if (this.month !== null) {
      reqData.month = this.month;
    }

    if (this.user) {
      reqData.user = this.user;
    }

    return reqData;
  },

  getValueStateData() {
    const data = {};
    const valueState = ReactEditor.stateValues;
    for (let i = 0; i < valueState.length; i++) {
      data[getAreaId(i)] = valueState[i];
    }
    return data;
  },

  getCheckedStateData() {
    const checkbox = document.querySelector('#id_state');
    if (!checkbox.checked) {
      return {};
    }
    return {
      [checkbox.name]: checkbox.value,
    };
  },


  /*
   * Unit navigation, display, submission
   */


  /* Renders a single row */
  renderHeaderRow(uid) {
    if (!this.units.headers[uid]) {
      return '';
    }

    const unit = this.units.units[uid];
    const caption = [
      unit.targetLanguageName,
      unit.projectName,
      unit.file,
    ].join('</li><li>');

    return (`
      <tr class="header-row js-header-row">
        <td colspan="2"><div class="unit-path"><ul><li>${caption}</li></ul></div></td>
      </tr>
    `);
  },

  renderViewRow(uid, unit, extraClassName, contextMode) {
    if (!unit) {
      return '';
    }

    const classNames = cx('view-row', {
      [extraClassName]: extraClassName,
    });

    return (`
      ${!contextMode && this.renderHeaderRow(uid)}
      <tr id="row${uid}" class="${classNames}">
        ${this.tmpl.vUnit({ unit })}
      </tr>
    `);
  },

  renderEditorRow(uid, unit) {
    const eClass = cx('edit-row', {
      'fuzzy-unit': unit.isfuzzy,
      'context-rows-available': (this.filter !== 'all'),
    });

    return (`
      <tr id="row${uid}" class="${eClass}">
        ${this.units.unit.editor}
      </tr>
    `);
  },


  /* Renders the view rows */
  renderViewRows(uids) {
    return uids.map(uid => this.renderViewRow(uid, this.units.units[uid]));
  },


  /* Renders the context rows */
  renderContextRows(units, rows) {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const uid = unit.id;
      rows.push(this.renderViewRow(uid, unit, 'ctx', true));
    }
  },


  handleContextPreviewMouseover() {
    if (this.filter === 'all') {
      return;
    }
    clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => {
      this.units.loadContextRows();
    }, SHOW_CONTEXT_ROWS_TIMEOUT);
  },


  handleContextPreviewMouseout(e) {
    if (this.filter === 'all') {
      return;
    }
    clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => {
      if (!e.ctrlKey) {
        this.hideContextRows();
      }
    }, HIDE_CONTEXT_ROWS_TIMEOUT);
  },


  /* shows the context rows in place of regular view rows */
  handleContextData(uid, ctx) {
    if (uid !== this.units.uid) {
      return;
    }
    this.showContextRows(ctx);
  },

  showContextRows(ctx) {
    const rowsBefore = [];
    this.renderContextRows(ctx.before, rowsBefore);

    const rowsAfter = [];
    this.renderContextRows(ctx.after, rowsAfter);

    // update DOM

    this.$contextRowsBefore.html(rowsBefore.join(''));
    this.$contextRowsAfter.html(rowsAfter.join(''));

    // hide view rows and show context rows

    this.$viewRowsBefore.addClass('context-mode');
    this.$contextRowsBefore.addClass('context-mode');

    this.$viewRowsAfter.addClass('context-mode');
    this.$contextRowsAfter.addClass('context-mode');
  },

  /* hides the context rows */
  hideContextRows() {
    clearTimeout(this.contextTimer);

    if (!this.$contextRowsBefore.hasClass('context-mode')) {
      return; // nothing to do
    }

    // hide context rows and show view rows

    this.$viewRowsBefore.removeClass('context-mode');
    this.$contextRowsBefore.removeClass('context-mode');

    this.$viewRowsAfter.removeClass('context-mode');
    this.$contextRowsAfter.removeClass('context-mode');
  },

  /* populates lead-in and lead-out row messages */
  populateLeadInOutMessages({ showCongratulationsMessage = false } = {}) {
    const leadIn = [];
    const leadOut = [];

    const canShow = (
      this.units.uids.length >
      this.units.visibleRowsBefore + this.units.visibleRowsAfter
    );

    if (canShow) {
      if (this.units.begin === 0) {
        leadIn.push(nt(
          'Found %(total)s unit.',
          'Found %(total)s units.',
          this.units.total, { total: this.units.total }
        ));
      } else {
        // there are some units above;
        // this can only happen when filter is set to 'all'
        leadIn.push(nt(
          'There are %(count)s more unit above.',
          'There are %(count)s more units above.',
          this.units.total, { count: this.units.begin }
        ));

        leadIn.push(t('Reload the page to see them.'));
      }
    }

    if (this.units.end === this.units.total) {
      if (showCongratulationsMessage) {
        leadOut.push(t('Congratulations, you went through all units!'));
        leadOut.push($('.js-back-to-browser').html());
      }
    } else {
      if (showCongratulationsMessage) {
        leadOut.push(t('Congratulations, you went through a good number of units!'));
      }

      if (canShow) {
        if (this.filter === 'all') {
          leadOut.push(t('Reload the page to see more units.'));
        } else if (this.filter === 'search') {
          leadOut.push(t(
            `There were more units that matched your search criteria.
          Please refine your search.`
          ));
        } else {
          leadOut.push(t(
            `There were more units that matched your filter.
          Reload the page to see if there is more stuff to go through,
          or use search to find specific units.`
          ));
        }
      }
    }

    return { leadIn, leadOut };
  },

  /* redraws the translate table view rows */
  redrawViewRows({ showCongratulationsMessage = false } = {}) {
    const messages = this.populateLeadInOutMessages({ showCongratulationsMessage });

    const rowsBefore = [`
      <tr>
        <td colspan="2" class="lead-in-row js-lead-in-row">
          <p>${messages.leadIn.join('</p><p>')}</p>
        </td>
      </tr>
    `];
    rowsBefore.push(this.renderViewRows(this.units.visibleUnitsBefore()));
    rowsBefore.push(this.renderHeaderRow(this.units.uid));

    const rowsAfter = [this.renderViewRows(this.units.visibleUnitsAfter())];
    rowsAfter.push(`
      <tr>
        <td colspan="2" class="lead-out-row">
          <p>${messages.leadOut.join('</p><p>')}</p>
        </td>
      </tr>
    `);

    // update DOM
    this.$viewRowsBefore.html(rowsBefore.join(''));
    this.$viewRowsAfter.html(rowsAfter.join(''));
  },


  /* redraws the edit row */
  redrawEditRow() {
    let editorRow = '';
    if (this.editorIsClosed) {
      // When the editor is closed, it is rendered as a view row but in the
      // context of the editor row section; we need to adjust its background so
      // that it follows the background stripe pattern of the upper view rows
      const rowsBefore = this.units.visibleUnitsBefore().length + 1; // add 1 for lead-in-row
      const className = rowsBefore % 2 === 1 ? 'even' : undefined;

      editorRow = this.renderViewRow(this.units.uid, this.units.unit, className);
    } else {
      editorRow = this.renderEditorRow(this.units.uid, this.units.unit);
    }

    this.$editorRow.html(editorRow);
    this.$editRowWrapper.toggleClass('view-mode', this.editorIsClosed).show();
  },

  /* Updates a `$button` to the `enable` state */
  updateNavButton($button, enable) {
    // Avoid unnecessary actions
    if ($button.is(':enabled') && enable || $button.is(':disabled') && !enable) {
      return;
    }

    if (enable) {
      $button.attr('title', $button.data('title'));
    } else {
      $button.data('title', $button.attr('title'));
      $button.removeAttr('title');
    }
    $button.prop('disabled', !enable);
  },


  /* Updates the navigation widget */
  updateNavigation() {
    this.updateNavButton(this.$navPrev,
                         !this.units.isOnFirstUnit());
    this.updateNavButton(this.$navNext, !this.units.isOnLastUnit());

    this.unitPositionEl.textContent = this.units.getPosition();
    this.unitCountEl.textContent = this.units.total;
  },


  /* Update edit row, because currently selected unit has changed */
  handleUnitChange(uid) {
    this.editorIsClosed = false;
    // When we're going to the first unit (and change the URL as a consequence),
    // we want to treat this as an 'internal redirect' and not to push it
    // into history stack
    const hashUid = parseInt(utils.getParsedHash().unit, 10);

    if (!hashUid) {
      history.replaceState(undefined, undefined,
                           `#${utils.updateHashPart('unit', uid)}`);
    } else if (uid !== hashUid) {
      history.pushState(undefined, undefined,
                        `#${utils.updateHashPart('unit', uid)}`);
    }
    this.updateNavigation();
    this.hideContextRows();

    this.redrawEditRow();
    this.redrawViewRows();

    this.ready();
  },


  /* Handle the 'No units found' case */
  handleEmptyResults({ htmlMessage } = {}) {
    this.editorIsClosed = true;
    this.isLoading = false;
    this.hideActivity();
    this.updateNavigation();
    this.hideContextRows();

    this.$viewRowsBefore.html(`
      <tr>
        <td colspan="2" class="no-results-row">${htmlMessage}</td>
      </tr>
    `);
    this.$editorRow.html('');
    this.$viewRowsAfter.html('');
    this.$editRowWrapper.hide();
  },

  /* Handle 'No units match your search' case */
  handleNoMatchingUnitsFound({ filter } = {}) {
    let htmlMessage;
    if (filter === 'all') {
      htmlMessage = `<p>${t('No units found in this translation scope.')}</p>`;
    } else {
      htmlMessage = `<p>${t('No units match your search criteria.')}</p>`;
    }
    this.handleEmptyResults({ htmlMessage });
  },

  /* Handle the 'Unit NNNNNN not found' case */
  handleUnitNotFound({ filter } = {}) {
    let htmlMessage;

    if (filter === 'all') {
      htmlMessage = `
        <p>${
          t('Unit #%(id)s is no longer available.', { id: this.units.uid })
        }</p>
        <p><a class="js-show-first-unit">${
          t('Show all other units in this translation scope')
        }</a></p>
      `;
    } else {
      htmlMessage = `
        <p>${
          t('Unit #%(id)s no longer matches your search criteria or is no longer available.',
            { id: this.units.uid })
          }</p>
        <p><a class="js-show-first-unit">${
          t('Show all other units matching your search criteria')
        }</a></p>
      `;
    }

    this.handleEmptyResults({ htmlMessage });
    $('.js-show-first-unit').on('click', (e) => {
      e.preventDefault();
      $.history.load(utils.updateHashPart('unit', this.units.uids[0]));
    });
  },

  /* Pushes translation submissions and moves to the next unit */
  handleSubmit({ translation = null, comment = '' } = {}) {
    const el = q('input.submit');
    let valueStateData = {};
    if (translation !== null) {
      valueStateData[getAreaId(0)] = translation;
    } else {
      valueStateData = this.getValueStateData();
    }
    const newTranslation = valueStateData[0];
    const suggestions = $('.js-user-suggestion').map(function getSuggestions() {
      return {
        text: this.dataset.translationAid,
        id: this.dataset.suggId,
      };
    }).get();

    this.updateUnitDefaultProperties();

    // Check if the string being submitted is already in the set of
    // suggestions
    // FIXME: this is LAME, I wanna die: we need to use proper models!!
    const suggestionIds = _.pluck(suggestions, 'id');
    const suggestionTexts = _.pluck(suggestions, 'text');
    const suggestionIndex = suggestionTexts.indexOf(newTranslation);

    if (suggestionIndex !== -1 && !this.isFuzzy()) {
      if (this.settings.canReview) {
        this.acceptSuggestion(suggestionIds[suggestionIndex], { skipToNext: true });
        return;
      }
      // Exact match suggestions are still accepted this way for users
      // with no review right
      this.selectedSuggestionId = suggestionIds[suggestionIndex];
    }

    // If similarities were in the process of being calculated by the time
    // the submit button was clicked, clear the timer and calculate them
    // straight away
    if (this.similarityTimer !== null) {
      clearTimeout(this.similarityTimer);
      this.checkSimilarTranslations();
    }

    const body = Object.assign(
      {}, this.getCheckedStateData(), valueStateData,
      this.getReqData(), this.getSimilarityData()
    );

    el.disabled = true;

    // Check if we used a suggestion
    if (this.selectedSuggestionId !== undefined) {
      const suggData = {
        suggestion: this.selectedSuggestionId,
        comment,
      };
      Object.assign(body, suggData);
    }

    UnitAPI.addTranslation(this.units.uid, body)
      .then(
        (data) => this.processSubmission(data),
        this.error
      );
  },

  processSubmission(data) {
    if (this.selectedSuggestionId !== undefined) {
      this.processAcceptSuggestion(data, this.selectedSuggestionId);
      return;
    }

    const unit = this.units.unit;
    unit.setTranslation(ReactEditor.stateValues);
    unit.setFuzzy(this.isFuzzy());

    const hasCriticalChecks = !!data.checks;
    $('.translate-container').toggleClass('error', hasCriticalChecks);

    if (data.user_score) {
      score.set(data.user_score);
    }

    if (hasCriticalChecks) {
      _refreshChecksSnippet(data.checks);
    } else {
      this.gotoNext();
    }
  },

  /* Pushes translation suggestions and moves to the next unit */
  handleSuggest() {
    this.updateUnitDefaultProperties();

    const body = Object.assign({}, this.getValueStateData(), this.getReqData(),
                        this.getSimilarityData());

    UnitAPI.addSuggestion(this.units.uid, body)
      .then(
        (data) => this.processSuggestion(data),
        this.error
      );
  },

  processSuggestion(data) {
    if (data.user_score) {
      score.set(data.user_score);
    }

    this.gotoNext();
  },


  /* Loads the previous unit */
  gotoPrev() {
    if (!this.canNavigate()) {
      return;
    }
    this.units.gotoPrev();
  },


  /* Loads the next unit */
  gotoNext(opts = { isSubmission: true }) {
    if (!this.canNavigate()) {
      return;
    }
    if (this.units.isOnLastUnit()) {
      if (opts.isSubmission) {
        // On submitting the last unit in a sequence, 'close' the editor row
        this.editorIsClosed = true;
        this.redrawEditRow();
        this.redrawViewRows({ showCongratulationsMessage: true });
        this.adjustEditorGeometry();
      }
      return;
    }
    this.units.gotoNext();
  },


  /* Loads the editor with a specific unit */
  gotoUnit(e) {
    e.preventDefault();

    if (!PTL.editor.canNavigate()) {
      return false;
    }

    // Ctrl + click / Alt + click / Cmd + click / Middle click opens a new tab
    if (e.ctrlKey || e.altKey || e.metaKey || e.which === 2) {
      const $el = e.target.nodeName !== 'TD' ?
                  $(e.target).parents('td') :
                  $(e.target);
      window.open($el.data('target'), '_blank');
      return false;
    }

    // Don't load anything if we're just selecting text or right-clicking
    if (window.getSelection().toString() !== '' || e.which === 3) {
      return false;
    }

    // Get clicked unit's uid from the row's id information and
    // try to load it
    const m = this.id.match(/row([0-9]+)/);
    if (m) {
      const uid = parseInt(m[1], 10);
      if ($(this).hasClass('ctx')) {
        $.history.load(
          utils.updateHashPart('unit', uid,
                               ['filter', 'search', 'sfields', 'soptions'])
        );
      } else {
        PTL.editor.units.goto(uid, { force: true });
      }
    }
    return true;
  },

  /*
   * Units filtering
   */

  /* Gets the failing check options for the current query */
  getCheckOptions() {
    StatsAPI.getChecks(this.settings.pootlePath)
      .then(
        (data) => this.updateChecksDropdown(data),
        this.error
      );
  },

  /* Loads units based on checks filtering */
  filterChecks() {
    if (this.preventNavigation) {
      return false;
    }
    if (!this.canNavigate()) {
      return false;
    }

    const name = this.$filterChecks.val();
    const isCategory = $(this.$filterChecks.select2('data').element)
      .data('type') === 'category';

    const sortBy = this.$filterSortBy.val();
    const newHash = {
      filter: 'checks',
    };

    if (name !== 'all') {
      if (isCategory) {
        newHash.category = name;
      } else {
        newHash.checks = name;
      }
    }

    if (sortBy !== 'default') {
      newHash.sort = sortBy;
    }

    $.history.load($.param(newHash));
    return true;
  },

  /* Adds the failing checks to the UI */
  updateChecksDropdown(checks) {
    const $checks = this.$filterChecks;

    $checks.find('optgroup').each(function displayGroups() {
      const $gr = $(this);
      let groupTotal = 0;

      $gr.find('option').each(function displayOptions() {
        const $opt = $(this);
        const value = $opt.val();

        if ($opt.hasClass('category')) {
          return;
        }

        if (value in checks) {
          groupTotal += checks[value];
        } else {
          $opt.remove();
        }
      });

      if (groupTotal === 0) {
        $gr.hide();
      }
    });
  },

  filterSort() {
    const filterBy = this.$filterStatus.val();
    // #104: Since multiple values can't be selected in the select
    // element, we also need to check for `this.checks`.
    const filterChecks = this.$filterChecks.val() || this.checks.join(',');
    const sortBy = this.$filterSortBy.val();
    const user = this.user || null;

    const newHash = {};
    if (filterBy !== 'all') {
      newHash.filter = filterBy;
    }

    if (this.category) {
      newHash.category = this.category;
    } else if (filterChecks !== 'all') {
      newHash.checks = filterChecks;
    }

    if (sortBy !== 'default') {
      newHash.sort = sortBy;
    }
    if (user !== null) {
      newHash.user = user;
    }

    $.history.load($.param(newHash));
  },


  /* Loads units based on filtering */
  filterStatus() {
    if (!this.canNavigate()) {
      return false;
    }

    // this function can be executed in different contexts,
    // so using the full selector here
    const $selected = this.$filterStatus.find('option:selected');
    const filterBy = $selected.val();

    this.$filterChecksWrapper.hide();

    if (!this.preventNavigation) {
      const newHash = {};
      if (filterBy !== 'all') {
        newHash.filter = filterBy;
      }
      const isUserFilter = $selected.data('user');

      if (this.user && isUserFilter) {
        newHash.user = this.user;
      } else {
        this.user = null;
        $('.js-user-filter').remove();

        if (this.sortBy !== 'default') {
          newHash.sort = this.sortBy;
        }
      }

      $.history.load($.param(newHash));
    }
    return true;
  },


  /* Loads the search view */
  onSearch(searchText) {
    if (!PTL.editor.canNavigate()) {
      return false;
    }

    let newHash;

    if (searchText) {
      const queryString = this.buildSearchQuery();
      newHash = `search=${queryString}`;
    } else {
      newHash = utils.updateHashPart(undefined, undefined,
                                     ['search', 'sfields', 'soptions']);
    }
    $.history.load(newHash);
    return true;
  },


  /*
   * Comments
   */

  addComment(e) {
    e.preventDefault();
    this.updateCommentDefaultProperties();

    UnitAPI.addComment(this.units.uid, $(e.target).serializeObject())
      .then(
        (data) => this.processAddComment(data),
        this.error
      );
  },

  processAddComment(data) {
    $('.js-editor-comment').removeClass('selected');
    $('#editor-comment').fadeOut(200);

    if ($('#translator-comment').length) {
      $(data.comment).hide().prependTo('#translator-comment').delay(200)
        .animate({ height: 'show' }, 1000, 'easeOutQuad');
    } else {
      $(`<div id='translator-comment'>${data.comment}</div>`)
        .prependTo('#extras-container').delay(200)
        .hide().animate({ height: 'show' }, 1000, 'easeOutQuad');
    }

    helpers.updateRelativeDates();
  },

  /* Removes last comment */
  removeComment(e) {
    e.preventDefault();

    UnitAPI.removeComment(this.units.uid)
      .then(
        () => $('.js-comment-first').fadeOut(200),
        this.error
      );
  },


  /*
   * Unit timeline
   */

  /* Get the timeline data */
  showTimeline() {
    const $results = $('#timeline-results');
    if ($results.length) {
      $results.show();
      this.adjustEditorGeometry();
      return;
    }

    const $node = $('.translate-container');
    $node.spin();

    UnitAPI.getTimeline(this.units.uid)
      .then(
        (data) => this.renderTimeline(data),
        this.error
      )
      .always(() => $node.spin(false));
  },

  renderTimeline(data) {
    const uid = data.uid;

    if (data.timeline && uid === this.units.uid) {
      if ($('#translator-comment').length) {
        $(data.timeline).insertAfter('#translator-comment');
      } else {
        $(data.timeline).prependTo('#extras-container');
      }
      qAll('.js-mount-timesince').forEach((el, i) => {
        const props = {
          timestamp: data.entries_group[i].timestamp,
        };
        ReactRenderer.render(<TimeSince {...props} />, el);
      });

      utils.highlightRONodes('.js-unit-highlight');

      $('.timeline-field-body').filter(':not([dir])').bidi();
      $('#js-show-timeline').addClass('selected');
      this.adjustEditorGeometry();
    }
  },

  /* Hide the timeline panel */
  toggleTimeline(e) {
    e.preventDefault();
    const $timelineToggle = $('#js-toggle-timeline');
    $timelineToggle.toggleClass('selected');
    if ($timelineToggle.hasClass('selected')) {
      this.showTimeline();
    } else {
      $('#timeline-results').hide();
      this.adjustEditorGeometry();
    }
  },


  /*
   * User and TM suggestions
   */

  /* TM: populates the empty textarea with the perfect match */
  populateWithPerfectMatch(result, sourceText) {
    if (sourceText !== result.source || ReactEditor.stateValues[0] !== '') {
      return;
    }

    // FIXME: move this side-effect elsewhere
    // save unit editor state to restore it after autofill changes
    const isUnitDirty = this.isUnitDirty;
    const text = result.target;
    ReactEditor.setValueFor(this.focused || 0, text);
    this.goFuzzy();
    this.isUnitDirty = isUnitDirty;
  },

  /* Rejects a suggestion */
  handleRejectSuggestion(suggId, { requestData = {} } = {}) {
    this.rejectSuggestion(suggId, { requestData });
  },

  rejectSuggestion(suggId, { requestData = {} } = {}) {
    UnitAPI.rejectSuggestion(this.units.uid, suggId, requestData)
      .then(
        (data) => this.processRejectSuggestion(data, suggId),
        this.error
      );
  },

  processRejectSuggestion(data, suggId) {
    if (data.user_score) {
      score.set(data.user_score);
    }

    $(`#suggestion-${suggId}`).fadeOut(200, function handleRemove() {
      PTL.editor.closeSuggestion({ checkIfCanNavigate: false });
      $(this).remove();
      PTL.editor.adjustEditorGeometry();

      // Go to the next unit if there are no more suggestions left
      if (!$('.js-user-suggestion').length) {
        PTL.editor.gotoNext();
      }
    });
  },


  /* Accepts a suggestion */
  handleAcceptSuggestion(
    suggId, { requestData = {}, isSuggestionChanged = false } = {}
  ) {
    if (isSuggestionChanged) {
      this.undoFuzzyBox();
      ReactEditor.setValueFor(0, requestData.translation);
      this.handleSubmit(requestData);
    } else {
      this.acceptSuggestion(suggId, { requestData });
    }
  },

  acceptSuggestion(suggId, { requestData = {}, skipToNext = false } = {}) {
    UnitAPI.acceptSuggestion(this.units.uid, suggId, requestData)
    .then(
      (data) => this.processAcceptSuggestion(data, suggId, skipToNext),
      this.error
    );
  },

  processAcceptSuggestion(data, suggId, skipToNext) {
    if (data.newtargets !== undefined) {
      for (let i = 0; i < data.newtargets.length; i++) {
        ReactEditor.setValueFor(i, data.newtargets[i]);
      }
    }
    this.updateUnitDefaultProperties();

    const unit = this.units.unit;
    unit.setTranslation(ReactEditor.stateValues);
    unit.setFuzzy(false);

    highlightSuggestionsDiff(unit);

    if (data.user_score) {
      score.set(data.user_score);
    }

    const hasCriticalChecks = !!data.checks;
    $('.translate-container').toggleClass('error', hasCriticalChecks);
    if (hasCriticalChecks) {
      _refreshChecksSnippet(data.checks);
    }

    $(`#suggestion-${suggId}`).fadeOut(200, function handleRemove() {
      PTL.editor.closeSuggestion({ checkIfCanNavigate: false });
      $(this).remove();
      PTL.editor.adjustEditorGeometry();

      // Go to the next unit if there are no more suggestions left,
      // provided there are no critical failing checks
      if (!hasCriticalChecks && (skipToNext || !$('.js-user-suggestion').length)) {
        PTL.editor.gotoNext();
      }
    });
  },

  /* Mutes or unmutes a quality check marking it as false positive or not */
  toggleCheck(checkId) {
    const $check = $(`.js-check-${checkId}`);
    const isFalsePositive = $check.hasClass('false-positive');

    const opts = isFalsePositive ? null : { mute: 1 };
    UnitAPI.toggleCheck(this.units.uid, checkId, opts)
      .then(
        () => this.processToggleCheck(checkId, isFalsePositive),
        this.error
      );
  },

  processToggleCheck(checkId, isFalsePositive) {
    $(`.js-check-${checkId}`).toggleClass('false-positive', !isFalsePositive);

    const hasError = $('#translate-checks-block .check')
      .not('.false-positive').size() > 0;

    $('.translate-container').toggleClass('error', hasError);
  },

  /*
   * Machine Translation
   */

  runHooks() {
    mtProviders.forEach((provider) => provider.init({
      unit: Object.assign({}, this.units.unit),
    }));
  },

  /* FIXME: provide an alternative to such an ad-hoc entry point */
  setTranslation(opts) {
    const { translation } = opts;
    if (translation === undefined && opts.msg) {
      this.displayError(opts.msg);
      return false;
    }

    ReactEditor.setValueFor(this.focused || 0, decodeEntities(translation));

    // Save a copy of the resulting text in the DOM for further
    // similarity comparisons
    this.focused.dataset.translationAidMt = translation;

    this.goFuzzy();

    return true;
  },

  openSuggestion(suggId, initialSuggestionText) {
    const suggestion = document.getElementById(`suggestion-${suggId}`);

    this.selectedSuggestionId = suggId;
    const props = {
      suggId,
      initialSuggestionText,
      localeDir: this.settings.localeDir,
      onAcceptSuggestion: this.handleAcceptSuggestion.bind(this),
      onRejectSuggestion: this.handleRejectSuggestion.bind(this),
      onChange: this.handleSuggestionFeedbackChange.bind(this),
    };
    const mountSelector = `.js-mnt-suggestion-feedback-${suggId}`;
    const feedbackMountPoint = q(mountSelector);
    const editorBody = q('.js-editor-cell');
    suggestion.classList.add('suggestion-expanded');
    editorBody.classList.add('suggestion-expanded');

    this.isSuggestionFeedbackFormDirty = false;
    ReactDOM.render(
      <SuggestionFeedbackForm {...props} />,
      feedbackMountPoint
    );
  },

  toggleSuggestion(e, { canHide = false } = {}) {
    if (this.selectedSuggestionId === undefined) {
      e.stopPropagation();
      const suggestionId = parseInt(e.currentTarget.dataset.suggId, 10);
      const initialSuggestionText = e.currentTarget.dataset.translationAid;
      this.openSuggestion(suggestionId, initialSuggestionText);
    } else if (canHide) {
      e.stopPropagation();
      this.closeSuggestion();
    }
    this.adjustEditorGeometry();
  },

  handleSuggestionFeedbackChange(isDirty) {
    this.isSuggestionFeedbackFormDirty = isDirty;
  },

  closeSuggestion({ checkIfCanNavigate = true } = {}) {
    if (this.selectedSuggestionId !== undefined &&
        (!checkIfCanNavigate || this.canNavigate())) {
      const suggestion = q(`#suggestion-${this.selectedSuggestionId}`);
      const editorBody = q('.js-editor-cell');
      const mountSelector = `.js-mnt-suggestion-feedback-${this.selectedSuggestionId}`;
      const feedbackMountPoint = q(mountSelector);
      editorBody.classList.remove('suggestion-expanded');
      suggestion.classList.remove('suggestion-expanded');
      ReactDOM.unmountComponentAtNode(feedbackMountPoint);
      this.selectedSuggestionId = undefined;
      this.isSuggestionFeedbackFormDirty = false;
    }
  },

  adjustEditorGeometry() {
    const editRowWrapper = $('.js-edit-row-wrapper');
    const editorTable = $('.js-editor-row');

    const toolbarHeight = $('#navbar').innerHeight() + $('#actions').innerHeight();
    const maxHeight = $(window).height() - toolbarHeight;
    const scrollHeight = editRowWrapper[0].scrollHeight;
    const editorTableHeight = editorTable.outerHeight();
    const editorHeight = Math.min(editorTableHeight, scrollHeight, maxHeight);
    const maxTopBlockHeight = Math.round(maxHeight / 5);
    const topBlockHeight = Math.min(
      maxTopBlockHeight,
      Math.max(Math.round((maxHeight - editorHeight) / 2), 0)
    );
    const bottomBlockHeight = maxHeight - editorHeight - topBlockHeight;

    $('.js-view-rows-before-wrapper').outerHeight(topBlockHeight);
    editRowWrapper.outerHeight(editorHeight);
    $('.js-view-rows-after-wrapper').outerHeight(bottomBlockHeight);

    const leadInRow = $('.js-lead-in-row');
    const headerRow = $('.js-header-row');
    const viewRowsBefore = $('.js-view-rows-before .view-row');
    const headerRowHeight = headerRow.length > 0 ? headerRow[0].scrollHeight : 0;
    let viewRowsBeforeHeight = 0;
    for (let i = 0; i < viewRowsBefore.length; i++) {
      viewRowsBeforeHeight += viewRowsBefore[i].scrollHeight;
    }
    const leadInRowHeight = (
      Math.max(0, topBlockHeight - viewRowsBeforeHeight - headerRowHeight * 2)
    );
    if (leadInRowHeight < 30) {
      leadInRow.hide();
    } else {
      leadInRow.outerHeight(leadInRowHeight).show();
    }

    setTimeout(() => {
      if (editorTable.height() === editRowWrapper[0].scrollHeight) {
        return;
      }

      // heights mismatch, need to adjust heights once again
      this.adjustEditorGeometry();
    }, 0);
  },

  handleWindowResize() {
    clearTimeout(this.handleWindowResizeTimer);
    if (this.isLoading) {
      return;
    }

    this.handleWindowResizeTimer = setTimeout(() => {
      this.adjustEditorGeometry();
    }, ADJUST_GEOMETRY_DELAY);
  },

  /* Previews */
  openPreviewLink(clickedPreviewLink) {
    if (!this.previewWindow || this.previewWindow.closed) {
      this.previewWindow = window.open(clickedPreviewLink.href, '_preview');
    } else {
      // an extra click on a currently highlighted preview link will just bring
      // the preview window to top and do nothing
      if (this.currentPreviewLink === clickedPreviewLink) {
        this.previewWindow.focus();
        return;
      }
    }

    // if the preview link is the same, do nothing
    if (this.currentPreviewLink &&
        this.currentPreviewLink.href === clickedPreviewLink) {
      return;
    }

    // move the highlighting from the old to a new link
    if (this.currentPreviewLink) {
      this.currentPreviewLink.classList.remove('highlighted');
    }
    this.currentPreviewLink = clickedPreviewLink;
    this.currentPreviewLink.classList.add('highlighted');

    // ask the preview server to handle the URL for us (this allows servers that
    // handle this message to navigate gracefully without reloading the page)
    this.previewWindow.postMessage({
      navigate: true,
      url: clickedPreviewLink.href,
    }, '*');

    // set a timeout to force set the new URL
    this.openLinkTimeout = setTimeout(() => {
      this.previewWindow.location.href = clickedPreviewLink;
    }, 200);
  },
};
