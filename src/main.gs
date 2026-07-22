/**
 * Gcal-picup: 外部との日程調整最適化ツール
 * エントリポイント / 初期化 / メンバー設定
 */

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('日程調整ツール')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * クライアント初期化用。1往復で必要な情報をまとめて返す。
 */
function getInitData() {
  return {
    userEmail: Session.getEffectiveUser().getEmail(),
    timeZone: Session.getScriptTimeZone(),
    members: getMembers_(),
    defaults: { durationMin: 60, dayStartHour: 8, dayEndHour: 20 }
  };
}

function getMembers_() {
  const json = PropertiesService.getUserProperties().getProperty('members');
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch (e) {
    return [];
  }
}

/**
 * メンバーリストを保存する。
 * @param {Array<{email: string, label: string}>} members
 */
function saveMembers(members) {
  if (!Array.isArray(members)) throw new Error('メンバーリストの形式が不正です');
  const cleaned = members
    .filter(function (m) { return m && m.email && String(m.email).indexOf('@') > 0; })
    .map(function (m) {
      return {
        email: String(m.email).trim(),
        label: String(m.label || m.email).trim()
      };
    });
  PropertiesService.getUserProperties().setProperty('members', JSON.stringify(cleaned));
  return cleaned;
}

/* ---- Phase 0 検証用: エディタから直接実行してログを確認する ---- */

function test_whoAmI() {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const count = CalendarApp.getDefaultCalendar().getEvents(start, end).length;
  Logger.log('user=%s tz=%s 今日の予定件数=%s',
    Session.getEffectiveUser().getEmail(), Session.getScriptTimeZone(), count);
}
