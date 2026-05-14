const DEFAULT_TIMEZONE = process.env.MEETING_TIMEZONE || 'Asia/Karachi';

let accessTokenCache = {
  token: null,
  expiresAt: 0
};

function isZoomConfigured() {
  return Boolean(
    process.env.ZOOM_ACCOUNT_ID &&
    process.env.ZOOM_CLIENT_ID &&
    process.env.ZOOM_CLIENT_SECRET
  );
}

function normalizeToken(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
}

function createJitsiMeeting({ topic, startAt, phoneNumber }) {
  const topicPart = normalizeToken(topic || 'meeting') || 'meeting';
  const attendeePart = normalizeToken(phoneNumber || 'client') || 'client';
  const timePart = new Date(startAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 12);
  const roomName = `ptis-${topicPart}-${attendeePart}-${timePart}`;
  const joinUrl = `https://meet.jit.si/${roomName}`;

  return {
    success: true,
    provider: 'jitsi',
    meetingId: `JITSI-${timePart}`,
    joinUrl,
    startUrl: joinUrl,
    password: ''
  };
}

async function getZoomAccessToken() {
  if (!isZoomConfigured()) {
    return { success: false, reason: 'not-configured' };
  }

  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt) {
    return { success: true, accessToken: accessTokenCache.token };
  }

  const auth = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        success: false,
        reason: 'token-failed',
        error: `Zoom token error (${response.status}): ${errText.substring(0, 250)}`
      };
    }

    const payload = await response.json();
    const expiresInSec = Number(payload.expires_in || 3600);

    accessTokenCache = {
      token: payload.access_token,
      expiresAt: Date.now() + Math.max(30, (expiresInSec - 60)) * 1000
    };

    return { success: true, accessToken: payload.access_token };
  } catch (error) {
    return { success: false, reason: 'token-failed', error: error.message };
  }
}

async function createZoomMeeting({ topic, startAt, durationMinutes = 30, agenda = '' }) {
  const tokenResult = await getZoomAccessToken();
  if (!tokenResult.success) {
    return tokenResult;
  }

  const zoomUser = process.env.ZOOM_USER_ID || 'me';
  const createUrl = `https://api.zoom.us/v2/users/${encodeURIComponent(zoomUser)}/meetings`;

  const body = {
    topic: topic || 'Client Meeting',
    type: 2,
    start_time: new Date(startAt).toISOString(),
    duration: durationMinutes,
    timezone: DEFAULT_TIMEZONE,
    agenda,
    settings: {
      join_before_host: false,
      waiting_room: true,
      auto_recording: 'none',
      approval_type: 2
    }
  };

  try {
    const response = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenResult.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        success: false,
        reason: 'meeting-failed',
        error: `Zoom meeting error (${response.status}): ${errText.substring(0, 300)}`
      };
    }

    const payload = await response.json();
    return {
      success: true,
      meetingId: payload.id ? String(payload.id) : '',
      joinUrl: payload.join_url || '',
      startUrl: payload.start_url || '',
      password: payload.password || ''
    };
  } catch (error) {
    return { success: false, reason: 'meeting-failed', error: error.message };
  }
}

async function createManagedMeeting({ topic, startAt, durationMinutes = 30, agenda = '' }) {
  if (!isZoomConfigured()) {
    return { success: false, reason: 'not-configured', error: 'Zoom credentials are not configured' };
  }

  const zoomResult = await createZoomMeeting({ topic, startAt, durationMinutes, agenda });
  if (zoomResult.success) {
    return { ...zoomResult, provider: 'zoom' };
  }

  return zoomResult;
}

module.exports = {
  isZoomConfigured,
  createZoomMeeting,
  createManagedMeeting
};
