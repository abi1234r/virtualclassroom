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

// Get camera + mic
// Get camera + mic with optimized constraints for multi-user calls
navigator.mediaDevices.getUserMedia({
    video: {
        width: { ideal: 320, max: 640 }, // Lower resolution (QVGA/VGA)
        height: { ideal: 240, max: 480 },
        frameRate: { max: 15 } // Lower frame rate to save CPU/Bandwidth
    },
    audio: true
})
    .then(stream => {
        localStream = stream;
        addVideo(stream, true, "local", "You", USER_ROLE);
        setupAudioVisualizer(stream, "local"); // Setup local visualizer
        socket.emit('join', { room: ROOM });
    });

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
        // Visual indicator on video
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

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = muted;
    if (id === 'local' && currentFilter !== 'none') {
        video.classList.add(currentFilter);
    }

    // Label construction
    const label = document.createElement('div');
    label.className = 'user-label';
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '8px';

    // Role Icon in label
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

    wrapper.appendChild(video);
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

        const dot = document.getElementById(`dot-local`); // Local dot
        if (dot) {
            if (average > 10 && !isMuted) { // Threshold
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
    // Resize video grid if needed (flexbox handles it mostly)
}

// MUTE / UNMUTE
function toggleMute() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    isMuted = !audioTrack.enabled;

    const btn = document.querySelector('.mute-btn');
    btn.classList.toggle('active', isMuted);
    // Google Meet shows red icon when muted
    btn.innerHTML = isMuted ? '<span class="material-symbols-rounded">mic_off</span>' : '<span class="material-symbols-rounded">mic</span>';
}

// CAMERA ON / OFF
function toggleCamera() {
    isCameraOff = !isCameraOff;
    localStream.getVideoTracks()[0].enabled = !isCameraOff;

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
    if (localStream) {
        replaceVideoTrack(localStream.getVideoTracks()[0]);
    }
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }
}

function replaceVideoTrack(newTrack) {
    for (let id in peers) {
        const sender = peers[id]._pc.getSenders().find(s => s.track.kind === "video");
        if (sender) sender.replaceTrack(newTrack);
    }
    const localWrapper = document.getElementById('wrapper-local');
    if (localWrapper) {
        const video = localWrapper.querySelector('video');
        video.srcObject = new MediaStream([newTrack]);
    }
}

// VIDEO FILTERS
function toggleFilter() {
    filterIndex = (filterIndex + 1) % filters.length;
    currentFilter = filters[filterIndex];

    const localWrapper = document.getElementById('wrapper-local');
    if (localWrapper) {
        const video = localWrapper.querySelector('video');
        filters.forEach(f => video.classList.remove(f));
        if (currentFilter !== 'none') video.classList.add(currentFilter);
    }

    showToast(`Filter applied: ${currentFilter.replace('filter-', '')}`);
    socket.emit('video-filter', { room: ROOM, filter: currentFilter });
}

// RAISE HAND
function raiseHand() {
    socket.emit('raise-hand', { room: ROOM });
    const btn = document.getElementById('handBtn');
    // Meet doesn't bounce the button, just highlights or shows notification. We'll simply Toast.
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

// END CALL
function endCall() {
    if (USER_ROLE === 'teacher') {
        if (confirm("End meeting for everyone?")) {
            // Teacher ends the meeting
            fetch(`/end_meeting/${ROOM}`, { method: 'POST' })
                .then(() => window.location.href = "/");
        }
    } else {
        // Student just leaves
        socket.emit("leave-room", { room: ROOM });
        window.location.href = "/";
    }
}

// Handle meeting ended by teacher
socket.on('meeting-ended', () => {
    alert("The teacher has ended the meeting.");
    window.location.href = "/";
});

// Show Participant Count
function showParticipantCount() {
    const count = Object.keys(peers).length + 1; // +1 for self
    showToast(`Participants: ${count}`);
}

