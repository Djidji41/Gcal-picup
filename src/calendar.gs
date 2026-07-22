/**
 * カレンダー読み取り: 自分の予定 + メンバーの空き状況(2段フォールバック)
 */

const TAG_GROUP_ID = 'gcalPicupGroupId';

/**
 * 自分の予定を取得する(週表示用)。
 * 仮予定(本ツールが作成した候補)はタグから判定して isCandidate/groupId を付ける。
 */
function getMyEvents(startIso, endIso) {
  const cal = CalendarApp.getDefaultCalendar();
  const events = cal.getEvents(new Date(startIso), new Date(endIso));
  return events.map(function (ev) {
    let groupId = null;
    try {
      groupId = ev.getTag(TAG_GROUP_ID);
    } catch (e) {
      // タグ未対応のイベント種別は無視
    }
    return {
      id: ev.getId(),
      title: ev.getTitle(),
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString(),
      isAllDay: ev.isAllDayEvent(),
      isCandidate: !!groupId,
      groupId: groupId || null
    };
  });
}

/**
 * メンバーの空き状況を取得する。
 * A案: CalendarApp で購読カレンダーから取得(詳細共有ならタイトル付き)
 * B案: A案で取れない場合、freeBusy REST を UrlFetchApp で直叩き
 *      (Advanced Services 不要・GCP プロジェクト不要)
 * どちらも不可の相手は status:'no_access' として返し、全体は落とさない。
 *
 * @return {{results: Object<string, {status: string, busy: Array, error?: string}>}}
 *   status: 'ok'(タイトル付き) | 'ok_busy_only'(時間帯のみ) | 'no_access'
 */
function getMembersFreeBusy(emails, startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const results = {};
  const needRest = [];

  (emails || []).forEach(function (email) {
    const r = tryGetViaCalendarApp_(email, start, end);
    if (r) {
      results[email] = r;
    } else {
      // 共有なし or 「予定の有無のみ公開」で0件に見えるケース。RESTで再確認する。
      needRest.push(email);
    }
  });

  if (needRest.length) {
    const restResults = fetchFreeBusyViaRest_(needRest, startIso, endIso);
    needRest.forEach(function (email) {
      results[email] = restResults[email] || { status: 'no_access', busy: [] };
    });
  }
  return { results: results };
}

/**
 * A案: CalendarApp 購読ベース。取得できない/0件のときは null を返してB案へ委ねる。
 */
function tryGetViaCalendarApp_(email, start, end) {
  let cal = null;
  try {
    cal = CalendarApp.getCalendarById(email);
    if (!cal) cal = CalendarApp.subscribeToCalendar(email);
  } catch (e) {
    return null; // 共有が一切ない相手は subscribeToCalendar が例外を投げる
  }
  if (!cal) return null;

  let events;
  try {
    events = cal.getEvents(start, end);
  } catch (e) {
    return null;
  }
  // 0件は「本当に空いている」と「free/busyのみ公開で見えない」の区別がつかないため
  // B案(freeBusy REST)で必ず再確認する
  if (!events.length) return null;

  return {
    status: 'ok',
    busy: events
      .filter(function (ev) { return !ev.isAllDayEvent(); })
      .map(function (ev) {
        return {
          start: ev.getStartTime().toISOString(),
          end: ev.getEndTime().toISOString(),
          title: ev.getTitle() || null
        };
      })
  };
}

/**
 * B案: freeBusy REST 直叩き。GASデフォルトプロジェクトのOAuthトークンで動くため
 * GCPプロジェクト作成やAdvanced Servicesの有効化は不要。
 * 「予定の有無のみ公開」の相手でも busy 区間が取れる。
 */
function fetchFreeBusyViaRest_(emails, timeMinIso, timeMaxIso) {
  const out = {};
  if (!emails.length) return out;
  try {
    const res = UrlFetchApp.fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({
        timeMin: timeMinIso,
        timeMax: timeMaxIso,
        timeZone: Session.getScriptTimeZone(),
        items: emails.map(function (e) { return { id: e }; })
      }),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() !== 200) {
      const msg = 'freeBusy API ' + res.getResponseCode() + ': ' + res.getContentText();
      Logger.log(msg);
      emails.forEach(function (e) {
        out[e] = { status: 'no_access', busy: [], error: msg };
      });
      return out;
    }

    const body = JSON.parse(res.getContentText());
    emails.forEach(function (email) {
      const c = body.calendars && body.calendars[email];
      if (!c || (c.errors && c.errors.length)) {
        out[email] = { status: 'no_access', busy: [] };
      } else {
        out[email] = {
          status: 'ok_busy_only',
          busy: (c.busy || []).map(function (b) {
            return { start: b.start, end: b.end, title: null };
          })
        };
      }
    });
  } catch (e) {
    // UrlFetchApp 自体の失敗(script.external_request が組織で制限されている等)
    const msg = String(e);
    Logger.log('freeBusy REST fetch failed: ' + msg);
    emails.forEach(function (em) {
      out[em] = { status: 'no_access', busy: [], error: msg };
    });
  }
  return out;
}

/* ---- Phase 2 検証用: メールアドレスを書き換えてエディタから実行 ---- */

function test_getMembersFreeBusy() {
  const emails = ['colleague@example.com']; // ←自分のチームのアドレスに書き換える
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  const result = getMembersFreeBusy(emails, start.toISOString(), end.toISOString());
  Logger.log(JSON.stringify(result, null, 2));
}

function test_getMyEvents() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  Logger.log(JSON.stringify(getMyEvents(start.toISOString(), end.toISOString()), null, 2));
}
