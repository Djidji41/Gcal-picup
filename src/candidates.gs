/**
 * 候補セット管理: 仮予定の一括登録・一覧・確定・取り下げ・整形テキスト生成
 *
 * 台帳は UserProperties(キー: grp_<uuid>)が正。
 * 各仮予定にもタグ(gcalPicupGroupId)を打ち、週表示の色分け・手動削除の検知に使う。
 */

const GROUP_KEY_PREFIX = 'grp_';
const TENTATIVE_PREFIX = '【仮】';
const COLOR_TENTATIVE = CalendarApp.EventColor.GRAY;

/**
 * 候補セットを作成する = 仮予定を一括登録する。
 * 仮予定の段階ではメンバーを招待しない(相手のカレンダーを複数枠で汚さないため)。
 *
 * @param {{title: string, memo?: string,
 *          slots: Array<{start: string, end: string}>,
 *          inviteOnConfirm?: string[]}} payload
 */
function createCandidateGroup(payload) {
  const title = String((payload && payload.title) || '打合せ').trim() || '打合せ';
  const slots = (payload && payload.slots) || [];
  if (!slots.length) throw new Error('候補日程が選択されていません');

  const groupId = Utilities.getUuid();
  const cal = CalendarApp.getDefaultCalendar();
  const n = slots.length;
  const inviteList = (payload && payload.inviteOnConfirm) || [];
  const inviteAtTentative = !!(payload && payload.inviteAtTentative) && inviteList.length > 0;
  const warnings = [];

  const saved = slots.map(function (s, i) {
    // 移動バッファ付きの候補は、カレンダー上の枠を前後に広げて確保する。
    // 台帳の start/end は打合せ時間のまま保持し、送付テキストにはそちらを使う。
    const bufferMin = Math.max(0, Number(s.bufferMin) || 0);
    const evStart = new Date(new Date(s.start).getTime() - bufferMin * 60000);
    const evEnd = new Date(new Date(s.end).getTime() + bufferMin * 60000);
    const ev = cal.createEvent(
      TENTATIVE_PREFIX + title + ' (' + (i + 1) + '/' + n + ')' +
        (bufferMin ? '【移動±' + bufferMin + '分込】' : ''),
      evStart,
      evEnd
    );
    ev.setTag(TAG_GROUP_ID, groupId);
    try {
      ev.setColor(COLOR_TENTATIVE);
    } catch (e) {
      // 色設定に失敗しても本質機能には影響しない
    }
    if (inviteAtTentative) {
      inviteList.forEach(function (email) {
        try {
          ev.addGuest(email);
        } catch (e) {
          warnings.push('招待に失敗: ' + email + ' (' + (i + 1) + '/' + n + ')');
        }
      });
    }
    return { eventId: ev.getId(), start: s.start, end: s.end, bufferMin: bufferMin };
  });

  const record = {
    groupId: groupId,
    title: title,
    memo: String((payload && payload.memo) || ''),
    createdAt: new Date().toISOString(),
    inviteOnConfirm: inviteList,
    inviteAtTentative: inviteAtTentative,
    slots: saved,
    status: 'pending'
  };
  PropertiesService.getUserProperties()
    .setProperty(GROUP_KEY_PREFIX + groupId, JSON.stringify(record));
  record.warnings = warnings;
  return record;
}

/**
 * 候補セット一覧。各仮予定の生存確認(手動削除の検知)付き。
 */
function listCandidateGroups() {
  const props = PropertiesService.getUserProperties().getProperties();
  const cal = CalendarApp.getDefaultCalendar();
  const groups = [];

  Object.keys(props).forEach(function (key) {
    if (key.indexOf(GROUP_KEY_PREFIX) !== 0) return;
    let rec;
    try {
      rec = JSON.parse(props[key]);
    } catch (e) {
      return; // 壊れた台帳エントリはスキップ
    }
    rec.slots.forEach(function (s) {
      s.deleted = !safeGetEvent_(cal, s.eventId);
    });
    groups.push(rec);
  });

  groups.sort(function (a, b) {
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return groups;
}

/**
 * 確定処理: 確定日以外の仮予定を削除し、確定予定のタイトルを正式化する。
 *
 * @param {string} groupId
 * @param {string} confirmedEventId
 * @param {{finalTitle?: string, invite?: boolean}} options
 */
function confirmCandidate(groupId, confirmedEventId, options) {
  options = options || {};
  const props = PropertiesService.getUserProperties();
  const key = GROUP_KEY_PREFIX + groupId;
  const raw = props.getProperty(key);
  if (!raw) throw new Error('候補セットが見つかりません');
  const rec = JSON.parse(raw);
  if (rec.status === 'confirmed') throw new Error('この候補セットは確定済みです');

  const cal = CalendarApp.getDefaultCalendar();
  const warnings = [];

  const confirmedEv = safeGetEvent_(cal, confirmedEventId);
  if (!confirmedEv) {
    throw new Error('確定対象の予定が見つかりません(カレンダー上で手動削除された可能性があります)');
  }

  let deleted = 0;
  rec.slots.forEach(function (s) {
    if (s.eventId === confirmedEventId) return;
    const ev = safeGetEvent_(cal, s.eventId);
    if (ev && safeDeleteEvent_(ev)) {
      deleted++;
    } else {
      warnings.push(formatSlot_(new Date(s.start), new Date(s.end)) + ' は既に削除されていました');
    }
  });

  const finalTitle = String(options.finalTitle || rec.title).trim() || rec.title;
  const confirmedSlot = rec.slots.filter(function (s) {
    return s.eventId === confirmedEventId;
  })[0] || {};
  // 移動バッファ付きの枠は、確定後もタイトルで移動込みと分かるようにする
  const bufferNote = confirmedSlot.bufferMin
    ? '【移動±' + confirmedSlot.bufferMin + '分込】'
    : '';
  confirmedEv.setTitle(finalTitle + bufferNote);

  // 仮予定の段階で招待済みなら確定イベントには既にゲストが載っている。
  // 他候補の削除でゲスト側カレンダーからも自動的に消えるため、追加処理は不要。
  if (options.invite && !rec.inviteAtTentative && rec.inviteOnConfirm && rec.inviteOnConfirm.length) {
    rec.inviteOnConfirm.forEach(function (email) {
      try {
        confirmedEv.addGuest(email);
      } catch (e) {
        warnings.push('招待に失敗しました: ' + email + ' (' + e + ')');
      }
    });
  }

  rec.status = 'confirmed';
  rec.confirmedEventId = confirmedEventId;
  rec.confirmedAt = new Date().toISOString();
  props.setProperty(key, JSON.stringify(rec));

  return { deleted: deleted, confirmedEventId: confirmedEventId, warnings: warnings };
}

/**
 * 候補セットの取り下げ: 残っている仮予定を全削除し、台帳からも消す。
 * 確定済みセットに対しては台帳エントリのみ削除する(確定予定は消さない)。
 */
function deleteCandidateGroup(groupId) {
  const props = PropertiesService.getUserProperties();
  const key = GROUP_KEY_PREFIX + groupId;
  const raw = props.getProperty(key);
  if (!raw) throw new Error('候補セットが見つかりません');
  const rec = JSON.parse(raw);

  const cal = CalendarApp.getDefaultCalendar();
  let deleted = 0;
  if (rec.status !== 'confirmed') {
    rec.slots.forEach(function (s) {
      const ev = safeGetEvent_(cal, s.eventId);
      if (ev && safeDeleteEvent_(ev)) deleted++;
    });
  }
  props.deleteProperty(key);
  return { deleted: deleted };
}

/**
 * 相手に送る整形テキストを生成する。
 * 例: ・7/28(月) 10:00〜11:00
 */
function buildCandidateText(groupId) {
  const raw = PropertiesService.getUserProperties().getProperty(GROUP_KEY_PREFIX + groupId);
  if (!raw) throw new Error('候補セットが見つかりません');
  const rec = JSON.parse(raw);
  return rec.slots
    .map(function (s) { return formatSlot_(new Date(s.start), new Date(s.end)); })
    .join('\n');
}

/* ---- 内部ヘルパー ---- */

function safeGetEvent_(cal, eventId) {
  try {
    return cal.getEventById(eventId); // 手動削除済みなら null
  } catch (e) {
    return null;
  }
}

/**
 * イベント削除の安全版。カレンダーUIで手動削除(ゴミ箱行き)済みのイベントは
 * getEventById がオブジェクトを返すのに deleteEvent() が例外を投げることがあるため、
 * 失敗しても処理全体を止めない。
 */
function safeDeleteEvent_(ev) {
  try {
    ev.deleteEvent();
    return true;
  } catch (e) {
    return false;
  }
}

function formatSlot_(start, end) {
  const tz = Session.getScriptTimeZone();
  const youbiMap = { Sun: '日', Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土' };
  const md = Utilities.formatDate(start, tz, 'M/d');
  const w = youbiMap[Utilities.formatDate(start, tz, 'EEE')] || '';
  const st = Utilities.formatDate(start, tz, 'HH:mm');
  const en = Utilities.formatDate(end, tz, 'HH:mm');
  return '・' + md + '(' + w + ') ' + st + '〜' + en;
}

/* ---- 開発用ユーティリティ(エディタから手動実行) ---- */

/** 台帳を全消去する(仮予定イベント自体は消さない)。 */
function test_resetAllProperties() {
  const props = PropertiesService.getUserProperties();
  Object.keys(props.getProperties()).forEach(function (key) {
    if (key.indexOf(GROUP_KEY_PREFIX) === 0) props.deleteProperty(key);
  });
  Logger.log('候補セット台帳をリセットしました');
}

/** タグ付きの仮予定を全削除し、台帳も消す(開発中のゴミ掃除用)。前後90日を走査。 */
function test_cleanupAllCandidates() {
  const cal = CalendarApp.getDefaultCalendar();
  const now = new Date();
  const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  let count = 0;
  cal.getEvents(start, end).forEach(function (ev) {
    let tag = null;
    try {
      tag = ev.getTag(TAG_GROUP_ID);
    } catch (e) { /* ignore */ }
    if (tag) {
      ev.deleteEvent();
      count++;
    }
  });
  test_resetAllProperties();
  Logger.log('仮予定を %s 件削除しました', count);
}
