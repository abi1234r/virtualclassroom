const socket = io();
const peers = {};
const videos = document.getElementById('videos');

let localStream;
let isMuted = false;
let isCameraOff = false;
let screenStream = null;
let currentFilter = 'none';
const filters = ['none', 'filter-grayscale', 'filter-sepia', 'filter-blur', 'filter-contrast', 'filter-hue'];
let filterIndex = 0;

// User metadata storage
const userMetadata = {};
const MY_PICTURE = typeof USER_PICTURE !== 'undefined' ? USER_PICTURE : '';

// Audio context for visualizer
let audioContext, analyser, microphone;

// Get camera + mic with optimized constraints for multi-user calls
navigator.mediaDevices.getUserMedia({
    video: {
        width: { ideal: 320, max: 640 },
        height: { ideal: 240, max: 480 },
        frameRate: { max: 15 }
    },
    audio: true
})
    .then(stream => {
        localStream = stream;
        addVideo(stream, true, "local", "You", USER_ROLE);
        setupAudioVisualizer(stream, "local");
        socket.emit('join', { room: ROOM });
    })
    .catch(err => {
        console.error("Camera/mic error:", err);

        // Distinguish between permission denied vs device not found
        const isDenied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
        const isNotFound = err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError';

        if (isDenied) {
            // Don't fallback silently — show a clear, actionable error overlay
            showCameraError(
                'permission',
                'Microphone & Camera access was blocked.',
                getBrowserPermissionInstructions()
            );
            // Still join the room (read-only/listen-only mode)
            socket.emit('join', { room: ROOM });
            return;
        }

        if (isNotFound) {
            // No camera found — try audio only
            navigator.mediaDevices.getUserMedia({ audio: true, video: false })
                .then(audioStream => {
                    localStream = audioStream;
                    addVideo(null, true, "local", "You (No Camera)", USER_ROLE);
                    setupAudioVisualizer(audioStream, "local");
                    socket.emit('join', { room: ROOM });
                    showToast("No camera found. Joined with audio only.");
                })
                .catch(audioErr => {
                    console.error("Audio fallback failed:", audioErr);
                    const isAudioDenied = audioErr.name === 'NotAllowedError' || audioErr.name === 'PermissionDeniedError';
                    showCameraError(
                        isAudioDenied ? 'permission' : 'fatal',
                        isAudioDenied ? 'Microphone access was blocked.' : 'No audio or video devices found.',
                        isAudioDenied ? getBrowserPermissionInstructions() : 'Please connect a microphone or camera and try again.'
                    );
                    socket.emit('join', { room: ROOM });
                });
            return;
        }

        // Try camera-only as fallback
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            .then(audioStream => {
                localStream = audioStream;
                addVideo(null, true, "local", "You (No Camera)", USER_ROLE);
                setupAudioVisualizer(audioStream, "local");
                socket.emit('join', { room: ROOM });
                showToast("Camera unavailable. Joined with audio only.");
            })
            .catch(() => {
                showCameraError('fatal', 'Camera and microphone are unavailable.', 'Please check your device connections and browser permissions, then rejoin.');
                socket.emit('join', { room: ROOM });
            });
    });

function getBrowserPermissionInstructions() {
    const ua = navigator.userAgent;
    if (ua.includes('Chrome') && !ua.includes('Edg')) {
        return 'In Chrome: click the <b>camera icon</b> in the address bar → Allow → reload the page.';
    } else if (ua.includes('Firefox')) {
        return 'In Firefox: click the <b>blocked camera icon</b> in the address bar → Remove Block → reload.';
    } else if (ua.includes('Edg')) {
        return 'In Edge: click the <b>lock icon</b> in the address bar → Permissions → Allow camera & mic → reload.';
    } else if (ua.includes('Safari')) {
        return 'In Safari: go to <b>Settings → Websites → Camera & Microphone</b> → Allow for this site → reload.';
    }
    return 'Click the <b>lock or camera icon</b> in your browser\'s address bar, allow camera & microphone, then reload.';
}

function showCameraError(type, title, instructions) {
    // Remove existing error overlay if any
    const existing = document.getElementById('cameraErrorOverlay');
    if (existing) existing.remove();

    const iconName = type === 'permission' ? 'no_photography' : 'videocam_off';
    const iconColor = type === 'permission' ? '#f59e0b' : '#ef4444';
    const bgColor = type === 'permission' ? 'rgba(245,158,11,0.08)' : 'rgba(239,68,68,0.08)';
    const borderColor = type === 'permission' ? 'rgba(245,158,11,0.25)' : 'rgba(239,68,68,0.25)';

    const overlay = document.createElement('div');
    overlay.id = 'cameraErrorOverlay';
    overlay.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: ${bgColor};
        border: 1px solid ${borderColor};
        border-radius: 16px;
        padding: 32px 28px;
        max-width: 360px;
        width: 90%;
        text-align: center;
        z-index: 500;
        backdrop-filter: blur(8px);
    `;

    overlay.innerHTML = `
        <span class="material-symbols-rounded" style="font-size:48px; color:${iconColor}; display:block; margin-bottom:12px;">${iconName}</span>
        <div style="font-size:16px; font-weight:700; color:white; margin-bottom:10px;">${title}</div>
        <div style="font-size:13px; color:#a1a1aa; line-height:1.7; margin-bottom:20px;">${instructions}</div>
        <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
            <button onclick="location.reload()" style="padding:10px 20px; background:#3b82f6; color:white; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer;">
                <span class="material-symbols-rounded" style="font-size:16px; vertical-align:middle;">refresh</span>
                Rejoin
            </button>
            <button onclick="document.getElementById('cameraErrorOverlay').remove()" style="padding:10px 20px; background:#27272a; color:#a1a1aa; border:1px solid #3f3f46; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer;">
                Dismiss
            </button>
        </div>
    `;

    // Append to meeting container so it floats over video grid without breaking layout
    const container = document.querySelector('.meeting-container') || document.body;
    container.appendChild(overlay);
}

// Receive list of existing users
socket.on('all-users', users => {
    users.forEach(u => {
        userMetadata[u.sid] = { username: u.username, picture: u.picture, role: u.role };
    });
});

// When new user joins
socket.on('new-user', data => {
    const userId = data.sid;
    const username = data.username;
    const picture = data.picture;
    const role = data.role;

    userMetadata[userId] = { username, picture, role };

    if (peers[userId]) return;
    const peer = createPeer(userId, true);
    peers[userId] = peer;

    showToast(`${username} joined the meeting`);
});

// Receive signaling data
socket.on('signal', data => {
    if (!peers[data.from]) {
        const peer = createPeer(data.from, false);
        peers[data.from] = peer;
    }
    peers[data.from].signal(data.signal);
});

// User Left
socket.on('user-left', data => {
    const userId = data.sid;
    const username = data.username;

    if (peers[userId]) {
        peers[userId].destroy();
        delete peers[userId];
    }
    const wrapper = document.getElementById(`wrapper-${userId}`);
    if (wrapper) wrapper.remove();
    showToast(`${username} left the meeting`);
});

// Raise Hand Event
socket.on('raise-hand', data => {
    const wrapper = document.getElementById(data.sid === socket.id ? `wrapper-local` : `wrapper-${data.sid}`);
    if (wrapper) {
        const label = wrapper.querySelector('.user-label');
        const originalHTML = label.innerHTML;
        label.innerHTML = `<span class="material-symbols-rounded" style="font-size:16px; color:#f1c40f;">front_hand</span> ` + label.innerText;

        showToast(`${data.username} raised their hand ✋`);

        setTimeout(() => {
            label.innerHTML = originalHTML;
        }, 5000);
    }
});

// Video Filter Event
socket.on('video-filter', data => {
    if (data.sid === socket.id) return;

    const wrapper = document.getElementById(`wrapper-${data.sid}`);
    if (wrapper) {
        const video = wrapper.querySelector('video');
        filters.forEach(f => video.classList.remove(f));
        if (data.filter !== 'none') video.classList.add(data.filter);
    }
});

function createPeer(userId, initiator) {
    const peer = new SimplePeer({
        initiator,
        trickle: false,
        stream: localStream
    });

    peer.on('signal', signal => {
        socket.emit('signal', {
            room: ROOM,
            signal,
            to: userId
        });
    });

    peer.on('stream', stream => {
        const metadata = userMetadata[userId] || { username: "Peer", picture: "", role: "student" };
        addVideo(stream, false, userId, metadata.username, metadata.role);
    });

    return peer;
}

// Add video to grid
function addVideo(stream, muted = false, id = "local", name = "User", role = "student") {
    const existing = document.getElementById(`wrapper-${id}`);
    if (existing) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    wrapper.id = `wrapper-${id}`;

    if (stream) {
        const video = document.createElement('video');
        video.srcObject = stream;
        video.autoplay = true;
        video.playsInline = true;
        video.muted = muted;
        if (id === 'local' && currentFilter !== 'none') {
            video.classList.add(currentFilter);
        }
        wrapper.appendChild(video);
    } else {
        // No camera — show avatar placeholder
        const placeholder = document.createElement('div');
        placeholder.style.cssText = `
            width:100%; height:100%; display:flex; flex-direction:column;
            align-items:center; justify-content:center; background:#1c1c1e; gap:8px;
        `;
        placeholder.innerHTML = `
            <span class="material-symbols-rounded" style="font-size:48px; color:#3f3f46;">videocam_off</span>
            <span style="font-size:12px; color:#52525b;">No Camera</span>
        `;
        wrapper.appendChild(placeholder);
    }

    // Label construction
    const label = document.createElement('div');
    label.className = 'user-label';
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';

    const roleIcon = document.createElement('span');
    roleIcon.className = 'material-symbols-rounded';
    roleIcon.style.fontSize = '20px';
    roleIcon.style.color = role === 'teacher' ? '#3b82f6' : '#a1a1aa';
    roleIcon.innerText = role === 'teacher' ? 'school' : 'person';

    const nameSpan = document.createElement('span');
    nameSpan.innerText = name;

    const audioDot = document.createElement('span');
    audioDot.className = 'audio-dot';
    audioDot.id = `dot-${id}`;

    label.appendChild(roleIcon);
    label.appendChild(nameSpan);
    label.appendChild(audioDot);

    wrapper.appendChild(label);
    videos.appendChild(wrapper);
}

// Audio Visualizer (Local only for demo of "pulse")
function setupAudioVisualizer(stream, id) {
    if (!AudioContext) return;
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);
    analyser.fftSize = 256;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function detectSound() {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
            sum += dataArray[i];
        }
        let average = sum / bufferLength;

        const dot = document.getElementById(`dot-local`);
        if (dot) {
            if (average > 10 && !isMuted) {
                dot.classList.add('speaking');
            } else {
                dot.classList.remove('speaking');
            }
        }
        requestAnimationFrame(detectSound);
    }
    detectSound();
}


// CHAT
function sendMsg() {
    let msgInput = document.getElementById('msg');
    let msg = msgInput.value;
    if (!msg) return;

    socket.emit('chat', { room: ROOM, msg });
    msgInput.value = "";

    addChatMessage(msg, true);
}

socket.on('chat', data => {
    addChatMessage(data.msg, false, data.username, data.role);
});

function addChatMessage(msg, isSelf, username = "You", role = "student") {
    const messages = document.getElementById('messages');

    const wrapper = document.createElement('div');
    wrapper.className = 'message-bubble';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'baseline';

    const sender = document.createElement('div');
    sender.className = 'message-sender';
    sender.style.display = 'flex';
    sender.style.alignItems = 'center';
    sender.style.gap = '8px';

    const userRole = isSelf ? USER_ROLE : role;
    const avatar = document.createElement('span');
    avatar.className = 'material-symbols-rounded';
    avatar.style.fontSize = '18px';
    avatar.style.color = userRole === 'teacher' ? '#3b82f6' : '#71717a';
    avatar.innerText = userRole === 'teacher' ? 'school' : 'person';

    const nameSpan = document.createElement('span');
    nameSpan.innerText = isSelf ? 'You' : username;

    sender.appendChild(avatar);
    sender.appendChild(nameSpan);

    const time = document.createElement('span');
    time.style.fontSize = '10px';
    time.style.color = '#71717a';
    time.innerText = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    header.appendChild(sender);
    header.appendChild(time);

    const text = document.createElement('div');
    text.innerText = msg;
    text.style.marginTop = '4px';

    wrapper.appendChild(header);
    wrapper.appendChild(text);

    messages.appendChild(wrapper);
    const sidebarContent = document.getElementById('sidebarContent');
    sidebarContent.scrollTop = sidebarContent.scrollHeight;

    if (!isSelf && !document.getElementById('sidebarPanel').classList.contains('open')) {
        showToast(`New message from ${username}`);
    }
}

function handleEnter(e) {
    if (e.key === 'Enter') sendMsg();
}

function toggleSidebar() {
    const panel = document.getElementById('sidebarPanel');
    panel.classList.toggle('open');
}

// MUTE / UNMUTE
function toggleMute() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    isMuted = !audioTrack.enabled;

    const btn = document.querySelector('.mute-btn');
    btn.classList.toggle('active', isMuted);
    btn.innerHTML = isMuted ? '<span class="material-symbols-rounded">mic_off</span>' : '<span class="material-symbols-rounded">mic</span>';
}

// CAMERA ON / OFF
function toggleCamera() {
    isCameraOff = !isCameraOff;
    if (localStream && localStream.getVideoTracks()[0]) {
        localStream.getVideoTracks()[0].enabled = !isCameraOff;
    }

    const btn = document.querySelector('.camera-btn');
    btn.classList.toggle('active', isCameraOff);
    btn.innerHTML = isCameraOff ? '<span class="material-symbols-rounded">videocam_off</span>' : '<span class="material-symbols-rounded">videocam</span>';
}

// SCREEN SHARE
async function shareScreen() {
    if (!screenStream) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            replaceVideoTrack(screenStream.getVideoTracks()[0]);

            screenStream.getVideoTracks()[0].onended = () => {
                stopScreenShare();
            };
        } catch (e) {
            console.error(e);
        }
    } else {
        stopScreenShare();
    }
}

function stopScreenShare() {
    if (localStream && localStream.getVideoTracks()[0]) {
        replaceVideoTrack(localStream.getVideoTracks()[0]);
    }
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }
}

function replaceVideoTrack(newTrack) {
    for (let id in peers) {
        const sender = peers[id]._pc.getSenders().find(s => s.track && s.track.kind === "video");
        if (sender) sender.replaceTrack(newTrack);
    }
    const localWrapper = document.getElementById('wrapper-local');
    if (localWrapper) {
        const video = localWrapper.querySelector('video');
        if (video) video.srcObject = new MediaStream([newTrack]);
    }
}

// VIDEO FILTERS
function toggleFilter() {
    filterIndex = (filterIndex + 1) % filters.length;
    currentFilter = filters[filterIndex];

    const localWrapper = document.getElementById('wrapper-local');
    if (localWrapper) {
        const video = localWrapper.querySelector('video');
        if (video) {
            filters.forEach(f => video.classList.remove(f));
            if (currentFilter !== 'none') video.classList.add(currentFilter);
        }
    }

    showToast(`Filter applied: ${currentFilter.replace('filter-', '')}`);
    socket.emit('video-filter', { room: ROOM, filter: currentFilter });
}

// RAISE HAND
function raiseHand() {
    socket.emit('raise-hand', { room: ROOM });
    showToast("You raised your hand ✋");
}

// TOAST
function showToast(text) {
    const t = document.getElementById('toast');
    const msg = document.getElementById('toastMsg');
    msg.innerText = text;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

// Stop all local media tracks (camera, mic)
function stopAllMedia() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
    }
}

// END CALL
function endCall() {
    if (USER_ROLE === 'teacher') {
        showEndCallModal();
    } else {
        stopAllMedia();
        socket.emit("leave-room", { room: ROOM });
        setTimeout(() => { window.location.href = "/"; }, 300);
    }
}

function showEndCallModal() {
    const modal = document.getElementById('endCallModal');
    if (modal) modal.style.display = 'flex';
}

function hideEndCallModal() {
    const modal = document.getElementById('endCallModal');
    if (modal) modal.style.display = 'none';
}

function confirmEndCall() {
    hideEndCallModal();
    stopAllMedia();
    fetch(`/end_meeting/${ROOM}`, { method: 'POST' }).catch(() => { });
    window.location.href = "/";
}

// Handle meeting ended by teacher
socket.on('meeting-ended', () => {
    alert("The teacher has ended the meeting.");
    window.location.href = "/";
});

// Show Participant Count
function showParticipantCount() {
    const count = Object.keys(peers).length + 1;
    showToast(`Participants: ${count}`);
}
