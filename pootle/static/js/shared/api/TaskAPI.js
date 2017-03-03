/*
 * Copyright (C) Zing contributors.
 *
 * This file is a part of the Zing project. It is distributed under the GPL3
 * or later license. See the LICENSE file for a copy of the license and the
 * AUTHORS file for copyright and authorship information.
 */

import fetch from 'utils/fetch';


const TaskAPI = {

  apiRoot: '/xhr/tasks/',

  get(languageCode, { offset = 0 } = {}) {
    let url = `${this.apiRoot}${languageCode}/`;
    if (offset > 0) {
      url = `${url}?offset=${offset}`;
    }
    return fetch({ url });
  },

};


export default TaskAPI;