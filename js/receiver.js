/**
Copyright 2022 Google LLC. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/


'use strict';

import { CastQueue } from './queuing.js';
import { MediaFetcher } from './media_fetcher.js';
import { AdsTracker, SenderTracker, ContentTracker } from './cast_analytics.js';
const mirrorImage = document.getElementById("mirrorImage");
const videoPlayer = document.getElementById("videoPlayer");
const message = document.getElementById('message');
var liveStreamActive = false;
var refreshInterval = null;
var imageErrorCnt = 20

/* =====================================================================
 * WebRTC live mirror — replaces the MJPEG /stream?live=true polling.
 * The phone (broadcast extension) is the OFFERER on ws://<ip>:8080/signaling;
 * this receiver is the ANSWERER. Video → <video>, audio → data channel + Web Audio.
 * ===================================================================== */
// Create the elements programmatically if index.html wasn't updated — this keeps
// the receiver from crashing (a thrown error in LOAD unloads the whole app).
let rtcVideo = document.getElementById('rtcVideo');
if (!rtcVideo) {
  rtcVideo = document.createElement('video');
  rtcVideo.id = 'rtcVideo';
  rtcVideo.autoplay = true; rtcVideo.muted = true; rtcVideo.setAttribute('playsinline', '');
  rtcVideo.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;background:#000;visibility:hidden;';
  document.body.appendChild(rtcVideo);
}
let dbgEl = document.getElementById('dbg');
if (!dbgEl) {
  dbgEl = document.createElement('div');
  dbgEl.id = 'dbg';
  dbgEl.style.cssText = 'position:fixed;top:0;left:0;right:0;max-height:45%;overflow:hidden;z-index:50;padding:8px;background:rgba(0,0,0,.5);color:#0f0;font:16px/1.3 monospace;white-space:pre-wrap;word-break:break-all;';
  document.body.appendChild(dbgEl);
}
const RTC_DEBUG = true; // set false to hide the on-screen overlay
const _dbgLines = [];
function rlog(s) {
  if (!RTC_DEBUG) return;
  const t = new Date().toISOString().substr(11, 8);
  _dbgLines.push(t + '  ' + s);
  while (_dbgLines.length > 14) _dbgLines.shift();
  if (dbgEl) { dbgEl.style.display = 'block'; dbgEl.textContent = _dbgLines.join('\n'); }
  try { console.log('[rtc]', s); } catch (e) {}
}

const PC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
// A/V sync tuning. RTC_AUDIO_LAT = target audio buffer; RTC_AUDIO_MAX = cap before
// the audio re-anchors (prevents audio drifting permanently behind the video);
// RTC_VIDEO_DELAY = how much to hold the video back (if the device honors it).
const RTC_AUDIO_LAT = 0.1, RTC_AUDIO_MAX = 0.25, RTC_VIDEO_DELAY = 0.4, RTC_RATE = 44100;
let rtcPC = null, rtcWS = null, rtcPend = [], rtcHasRemote = false;
let rtcAc = null, rtcGain = null, rtcFirstPts = null, rtcEpoch = null, rtcUpto = 0;

function rtcEnsureAudio() {
  if (!rtcAc) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    rtcAc = new C(); rtcGain = rtcAc.createGain(); rtcGain.connect(rtcAc.destination);
    rtcAc.onstatechange = () => rlog('AudioContext ' + rtcAc.state);
  }
  if (rtcAc.state === 'suspended') rtcAc.resume();
  return rtcAc;
}
function rtcSchedule(i16, pts) {
  const ctx = rtcEnsureAudio(); if (!ctx || ctx.state !== 'running') return;
  const n = i16.length; if (!n) return;
  const now = ctx.currentTime;
  // GAPLESS chaining: each frame starts exactly where the previous one ended, so
  // there are no inter-buffer gaps → no clicks/crackle. (Relies on the ordered
  // data channel so frames are already in sequence.) Re-anchor to the target
  // latency only when the stream drained or the backlog grew too large.
  if (rtcUpto < now + 0.002 || (rtcUpto - now) > RTC_AUDIO_MAX) rtcUpto = now + RTC_AUDIO_LAT;
  const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = i16[i] / 32768;
  const buf = ctx.createBuffer(1, n, RTC_RATE); buf.copyToChannel(f, 0);
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(rtcGain);
  src.start(rtcUpto); rtcUpto += buf.duration;
}
function rtcSend(o) { if (rtcWS && rtcWS.readyState === 1) rtcWS.send(JSON.stringify(o)); }
function rtcMakePC() {
  rtcPC = new PC({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  rtcPC.ontrack = (ev) => {
    rlog('ontrack ' + ev.track.kind);
    if (ev.track.kind !== 'video') return;
    rtcVideo.srcObject = ev.streams[0];
    // Delay video to line up with the (slightly buffered) data-channel audio.
    try { ev.receiver.jitterBufferTarget = RTC_VIDEO_DELAY * 1000; } catch (e) {}
    try { ev.receiver.playoutDelayHint = RTC_VIDEO_DELAY; } catch (e) {}
    rtcVideo.play().then(() => rlog('video.play ok')).catch(e => rlog('play fail: ' + e.message));
  };
  rtcPC.ondatachannel = (ev) => {
    if (ev.channel.label !== 'audio') return;
    ev.channel.binaryType = 'arraybuffer';
    ev.channel.onmessage = (msg) => {
      const b = msg.data; if (!(b instanceof ArrayBuffer) || b.byteLength < 8) return;
      rtcSchedule(new Int16Array(b, 8), new DataView(b).getFloat64(0, true));
    };
  };
  rtcPC.onicecandidate = (ev) => { if (ev.candidate) rtcSend({ type: 'ice-candidate', candidate: ev.candidate }); };
  rtcPC.oniceconnectionstatechange = () => rlog('ICE ' + rtcPC.iceConnectionState);
  rtcPC.onconnectionstatechange = () => rlog('PC ' + rtcPC.connectionState);
  return rtcPC;
}
function rtcHandle(m) {
  if (m.type === 'offer') {
    rlog('offer received');
    const p = rtcMakePC();
    p.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: m.sdp }))
      .then(() => { rtcHasRemote = true; rtcPend.forEach(c => p.addIceCandidate(new RTCIceCandidate(c))); rtcPend = []; return p.createAnswer(); })
      .then(a => p.setLocalDescription(a).then(() => { rtcSend({ type: 'answer', sdp: a.sdp }); rlog('answer sent'); }))
      .catch(e => rlog('negotiation fail: ' + e.message));
  } else if (m.type === 'ice-candidate') {
    if (rtcHasRemote && rtcPC) rtcPC.addIceCandidate(new RTCIceCandidate(m.candidate)).catch(() => {});
    else rtcPend.push(m.candidate);
  }
}

/** Start the WebRTC mirror. `source` is the cast contentUrl carrying the phone IP. */
function startWebRTCMirror(source) {
  // Stop any legacy MJPEG polling.
  liveStreamActive = false;
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }

  if (!PC) { rlog('FATAL: RTCPeerConnection không hỗ trợ trên thiết bị'); return; }

  let host = null;
  try { host = new URL(source).hostname; } catch (e) {}
  if (!host) { rlog('FATAL: không lấy được IP từ ' + source); return; }
  const sig = 'ws://' + host + ':8080/signaling';

  stopWebRTCMirror();           // tear down any previous session
  mirrorImage.style.visibility = 'hidden';
  videoPlayer.style.visibility = 'hidden';
  rtcVideo.style.visibility = 'visible';
  rtcEnsureAudio();             // Cast devices usually allow autoplay
  rlog('Connecting ' + sig);
  try {
    rtcWS = new WebSocket(sig);
    rtcWS.onopen = () => rlog('Signaling OPEN');
    rtcWS.onerror = () => rlog('Signaling ERROR (mixed-content? wss cần thiết?)');
    rtcWS.onclose = () => rlog('Signaling CLOSED');
    rtcWS.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } rtcHandle(m); };
  } catch (e) { rlog('WebSocket lỗi: ' + e.message); }
}

/** Tear down the WebRTC mirror (when switching to a photo / video cast). */
function stopWebRTCMirror() {
  if (rtcWS) { try { rtcWS.close(); } catch (e) {} rtcWS = null; }
  if (rtcPC) { try { rtcPC.close(); } catch (e) {} rtcPC = null; }
  rtcPend = []; rtcHasRemote = false;
  rtcFirstPts = null; rtcEpoch = null; rtcUpto = 0;
  if (rtcVideo) { rtcVideo.srcObject = null; rtcVideo.style.visibility = 'hidden'; }
}

// Periodic on-screen heartbeat so we can SEE frames arriving on the TV.
setInterval(() => {
  if (rtcVideo && rtcVideo.videoWidth) {
    const aLat = (rtcAc && rtcAc.state === 'running') ? (rtcUpto - rtcAc.currentTime) : -1;
    rlog('video ' + rtcVideo.videoWidth + 'x' + rtcVideo.videoHeight + (rtcVideo.paused ? ' PAUSED' : ' playing') + ' | audioLat=' + aLat.toFixed(2) + 's');
  }
}, 3000);

/**
 * @fileoverview This sample demonstrates how to build your own Web Receiver for
 * use with Google Cast. The main receiver implementation is provided in this
 * file which sets up access to the CastReceiverContext and PlayerManager. Some
 * added functionality can be enabled by uncommenting some of the code blocks
 * below.
 */


/*
 * Convenience variables to access the CastReceiverContext and PlayerManager.
 */
const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

/*
 * Constant to be used for fetching media by entity from sample repository.
 */
const ID_REGEX = '\/?([^\/]+)\/?$';

/**
 * Debug Logger
 */
const castDebugLogger = cast.debug.CastDebugLogger.getInstance();
const LOG_RECEIVER_TAG = 'Receiver';

/*
 * WARNING: Make sure to turn off debug logger for production release as it
 * may expose details of your app.
 * Uncomment below line to enable debug logger, show a 'DEBUG MODE' tag at
 * top left corner and show debug overlay.
 */
//  context.addEventListener(cast.framework.system.EventType.READY, () => {
//   if (!castDebugLogger.debugOverlayElement_) {
//     /**
//      *  Enable debug logger and show a 'DEBUG MODE' tag at
//      *  top left corner.
//      */
//       castDebugLogger.setEnabled(true);

//     /**
//      * Show debug overlay.
//      */
//       castDebugLogger.showDebugLogs(true);
//   }
// });

/*
 * Set verbosity level for Core events.
 */
castDebugLogger.loggerLevelByEvents = {
  'cast.framework.events.category.CORE':
    cast.framework.LoggerLevel.INFO,
  'cast.framework.events.EventType.MEDIA_STATUS':
    cast.framework.LoggerLevel.DEBUG
};

if (!castDebugLogger.loggerLevelByTags) {
  castDebugLogger.loggerLevelByTags = {};
}

/*
 * Set verbosity level for custom tag.
 * Enables log messages for error, warn, info and debug.
 */
castDebugLogger.loggerLevelByTags[LOG_RECEIVER_TAG] =
  cast.framework.LoggerLevel.DEBUG;

/*
 * Example of how to listen for events on playerManager.
 */
playerManager.addEventListener(
  cast.framework.events.EventType.ERROR, (event) => {
    castDebugLogger.error(LOG_RECEIVER_TAG,
      'Detailed Error Code - ' + event.detailedErrorCode);
    if (event && event.detailedErrorCode == 905) {
      castDebugLogger.error(LOG_RECEIVER_TAG,
        'LOAD_FAILED: Verify the load request is set up ' +
        'properly and the media is able to play.');
    }
  });

/*
 * Example analytics tracking implementation. To enable this functionality see
 * the implmentation and complete the TODO item in ./google_analytics.js. Once
 * complete uncomment the the calls to startTracking below to enable each
 * Tracker.
 */
const adTracker = new AdsTracker();
const senderTracker = new SenderTracker();
const contentTracker = new ContentTracker();
// adTracker.startTracking();
// senderTracker.startTracking();
// contentTracker.startTracking();

/**
 * Modifies the provided mediaInformation by adding a pre-roll break clip to it.
 * @param {cast.framework.messages.MediaInformation} mediaInformation The target
 * MediaInformation to be modified.
 * @return {Promise} An empty promise.
 */
function addBreaks(mediaInformation) {
  castDebugLogger.debug(LOG_RECEIVER_TAG, "addBreaks: " +
    JSON.stringify(mediaInformation));
  return MediaFetcher.fetchMediaById('fbb_ad')
    .then((clip1) => {
      mediaInformation.breakClips = [
        {
          id: 'fbb_ad',
          title: clip1.title,
          contentUrl: clip1.stream.dash,
          contentType: 'application/dash+xml',
          whenSkippable: 5
        }
      ];

      mediaInformation.breaks = [
        {
          id: 'pre-roll',
          breakClipIds: ['fbb_ad'],
          position: 0
        }
      ];
    });
}

/*
 * Intercept the LOAD request to load and set the contentUrl.
 */
// playerManager.setMessageInterceptor(
//   cast.framework.messages.MessageType.LOAD,
//   loadRequestData => {
//       console.log("📡 Nhận yêu cầu LOAD:", loadRequestData);
//       message.textContent += "📷 Live stream mode activated!";
//       if (!loadRequestData.media || !loadRequestData.media.contentUrl) {
//         message.textContent += '⚠️ Không có contentUrl trong media.';
//           console.log('❌ Không có contentUrl:', loadRequestData.media);
//           return null;
//       }

//       const imageUrl = loadRequestData.media.contentUrl;
//       console.log('✅ Nhận URL:', imageUrl);

//       if (imageUrl.includes("live=true")) {
//         message.textContent += "📷 Live stream mode activated!";
//           startLiveImageStream(imageUrl);
//       } else {
//         message.textContent += "📷 Loading single image...";
//           loadSingleImage(imageUrl);
//       }
//       return null;
//   }
// );
playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.LOAD, loadRequestData => {

    // Dừng live stream nếu có yêu cầu mới

    if (!loadRequestData || !loadRequestData.media) {
      return new cast.framework.messages.ErrorData(
        cast.framework.messages.ErrorType.LOAD_FAILED,
        cast.framework.messages.ErrorReason.INVALID_REQUEST
      );
    }
    let media = loadRequestData.media;
    let mimeType = media.contentType || "";
    let source = media.contentUrl || media.entity || media.contentId;

    if (!source || !source.match(ID_REGEX)) {
      return new cast.framework.messages.ErrorData(
        cast.framework.messages.ErrorType.LOAD_FAILED,
        cast.framework.messages.ErrorReason.INVALID_REQUEST
      );
    }

    let sourceId = source.match(ID_REGEX)[1];

    if (mimeType.startsWith("image/")) {

      if (source.includes("live=true")) {
        // WebRTC live mirror (replaces MJPEG /stream?live=true). Never let this
        // throw out of the interceptor — an uncaught error unloads the receiver.
        try { startWebRTCMirror(source); } catch (e) { rlog('startWebRTCMirror error: ' + e.message); }
      } else {
        try { stopWebRTCMirror(); } catch (e) {}
        loadSingleImage(source);

      }
      return null
    } else {
      try { stopWebRTCMirror(); } catch (e) {}
      liveStreamActive = false
      clearInterval(refreshInterval)
      // Nếu không phải ảnh, hiển thị videoPlayer và tải như cũ
      mirrorImage.style.visibility = 'hidden';
      videoPlayer.style.visibility = 'visible';

      if (sourceId.includes('.')) {
        castDebugLogger.debug(LOG_RECEIVER_TAG, "Interceptor received full URL");
        media.contentUrl = source;
        return loadRequestData;
      } else {
        castDebugLogger.debug(LOG_RECEIVER_TAG, "Interceptor received ID");
        return MediaFetcher.fetchMediaInformationById(sourceId)
          .then((mediaInformation) => {
            loadRequestData.media = mediaInformation;
            return loadRequestData;
          })
      }
    }
  }
);



// Kiểm tra định dạng hình ảnh
function isImageFormat(url) {
  return url.match(/\.(jpeg|jpg|png|gif|webp)$/i);
}

function loadSingleImage(url) {
  liveStreamActive = false;
  if (refreshInterval) clearInterval(refreshInterval);

  mirrorImage.src = url;
  mirrorImage.onload = function () {
    mirrorImage.style.visibility = 'visible';
    videoPlayer.style.visibility = 'hidden';
    // message.textContent += "✅ Image loaded successfully!";
  };
  mirrorImage.onerror = function () {
    // message.textContent += "❌ Error loading image.";
  };
}

/*
 * Set the control buttons in the UI controls.
 */
const controls = cast.framework.ui.Controls.getInstance();
controls.clearDefaultSlotAssignments();

// Assign buttons to control slots.
controls.assignButton(
  cast.framework.ui.ControlsSlot.SLOT_SECONDARY_1,
  cast.framework.ui.ControlsButton.QUEUE_PREV
);
controls.assignButton(
  cast.framework.ui.ControlsSlot.SLOT_PRIMARY_1,
  cast.framework.ui.ControlsButton.CAPTIONS
);
controls.assignButton(
  cast.framework.ui.ControlsSlot.SLOT_PRIMARY_2,
  cast.framework.ui.ControlsButton.SEEK_FORWARD_15
);
controls.assignButton(
  cast.framework.ui.ControlsSlot.SLOT_SECONDARY_2,
  cast.framework.ui.ControlsButton.QUEUE_NEXT
);

/*
 * Configure the CastReceiverOptions.
 */
const castReceiverOptions = new cast.framework.CastReceiverOptions();

/*
 * Set the player configuration.
 */
const playbackConfig = new cast.framework.PlaybackConfig();
playbackConfig.autoResumeDuration = 5;
castReceiverOptions.playbackConfig = playbackConfig;
castReceiverOptions.disableIdleTimeout = true;
castReceiverOptions.maxInactivity = 3600;

castDebugLogger.info(LOG_RECEIVER_TAG,
  `autoResumeDuration set to: ${playbackConfig.autoResumeDuration}`);

/* 
 * Set the SupportedMediaCommands.
 */
castReceiverOptions.supportedCommands =
  cast.framework.messages.Command.ALL_BASIC_MEDIA |
  cast.framework.messages.Command.QUEUE_PREV |
  cast.framework.messages.Command.QUEUE_NEXT |
  cast.framework.messages.Command.STREAM_TRANSFER

/*
 * Optionally enable a custom queue implementation. Custom queues allow the
 * receiver app to manage and add content to the playback queue. Uncomment the
 * line below to enable the queue.
 */
//castReceiverOptions.queue = new CastQueue();

context.start(castReceiverOptions);
