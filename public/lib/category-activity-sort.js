/* Optional: Category 7 visual sort by WuKong topic chat activity.
 * This sorts /category/7 topic rows visually by last chat activity from /bridge/topic-activity.
 * It does NOT change NodeBB database sorting; server-side latest-reply sorting needs a real backend hook.
 */
(function () {
  'use strict';

  if (window.__cpCategory7ActivitySortV13) return;
  window.__cpCategory7ActivitySortV13 = true;

  var CID = 7;

  function isCat7() {
    return document.body &&
      document.body.classList.contains('page-category') &&
      /\/category\/7(\/|$)/.test(location.pathname);
  }

  function tidFromHref(href) {
    var m = String(href || '').match(/\/topic\/(\d+)/);
    return m ? m[1] : '';
  }

  function findTopicRows() {
    var anchors = Array.prototype.slice.call(document.querySelectorAll('a[href*="/topic/"]'));
    var rows = [];
    var seen = {};

    anchors.forEach(function (a) {
      var tid = tidFromHref(a.getAttribute('href'));
      if (!tid || seen[tid]) return;

      var row = a.closest('[component="category/topic"], [component="topic"], li, .card, .category-item, .topic-row');
      if (!row || !row.parentNode) return;

      seen[tid] = true;
      rows.push({
        tid: tid,
        row: row,
        parent: row.parentNode
      });
    });

    return rows;
  }

  async function sortByActivity() {
    if (!isCat7()) return;

    var rows = findTopicRows();
    if (!rows.length) return;

    var res = await fetch('/bridge/topic-activity?cid=' + CID, {
      credentials: 'include'
    }).catch(function () {
      return null;
    });

    if (!res || !res.ok) return;

    var json = await res.json().catch(function () {
      return null;
    });

    var list = (json && json.list) || [];
    var map = {};

    list.forEach(function (x) {
      map[String(x.tid)] = Number(x.last_chat_at || 0);
    });

    rows.sort(function (a, b) {
      return (map[b.tid] || 0) - (map[a.tid] || 0);
    });

    rows.forEach(function (x) {
      if (x.parent && x.row) x.parent.appendChild(x.row);
    });
  }

  function boot() {
    setTimeout(sortByActivity, 600);
  }

  if (window.ajaxify && ajaxify.on) {
    ajaxify.on('action:ajaxify.end', boot);
  }

  document.addEventListener('DOMContentLoaded', boot);
  boot();
})();
