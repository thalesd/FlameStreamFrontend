export const BACKEND_BASE    = 'https://flamestream.tdonsoft.com:5001';
export const CAST_MEDIA_BASE = 'https://flamestream.tdonsoft.com:5001';

// ── Custom Receiver App ID ────────────────────────────────────────────────────
// Steps to get your own ID:
//   1. Go to https://cast.google.com/u/0/publish  (one-time $5 registration)
//   2. Add your Chromecast serial number under "Test Devices" (no review needed)
//   3. Add Application → Custom Receiver
//      Receiver URL: https://flamestream.tdonsoft.com:5001/receiver.html
//   4. Paste the generated App ID below
//
// Until then, 'CC1AD845' is the Default Media Receiver (Google's built-in UI).
export const RECEIVER_APP_ID = 'C11796B2';