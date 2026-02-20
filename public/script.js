const socket = io();

// UI Elements
const appContainer = document.getElementById('app');
const loginModal = document.getElementById('login-modal');
const profileCards = document.querySelectorAll('.profile-card');
const colorDots = document.querySelectorAll('.color-dot');

const topAvatar = document.getElementById('top-avatar');
const topAvatarFallback = document.getElementById('top-avatar-fallback');
const currentUsernameEl = document.getElementById('current-username');
const settingsTrigger = document.getElementById('settings-trigger');

const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const premiumThemeSelector = document.getElementById('premium-theme-selector');

const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const messagesList = document.getElementById('messages-list');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        if (file.size > 5 * 1024 * 1024) {
            alert('Image trop volumineuse (5 Mo max).');
            return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
            // Envoyer l'image encodée en base64 sous forme de balise img dans le chat
            socket.emit('chat:message', `<img class="chat-img" src="${ev.target.result}" alt="Image partagée">`);
        };
        reader.readAsDataURL(file);
    }
});

const voiceChannelBtn = document.getElementById('voice-channel-btn');
const activeVoiceControls = document.getElementById('active-voice-controls');
const micBtn = document.getElementById('mic-btn');
const screenBtn = document.getElementById('screen-btn');
const disconnectBtn = document.getElementById('disconnect-btn');

const videoSection = document.getElementById('video-section');
const videoGrid = document.getElementById('video-grid');
const voiceGrid = document.getElementById('voice-grid');
const fullscreenBtn = document.getElementById('fullscreen-btn');

const chatSection = document.getElementById('chat-section');

// Fullscreen & Theater mode combined
fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        appContainer.requestFullscreen().catch(err => {
            console.error(`Erreur plein écran: ${err.message}`);
        });
    } else {
        document.exitFullscreen();
    }
});

// Écouter les changements de plein écran pour appliquer le mode théâtre & cacher le chat
document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
        appContainer.classList.add('theater-mode');
        chatSection.classList.add('chat-collapsed');
    } else {
        appContainer.classList.remove('theater-mode');
        chatSection.classList.remove('chat-collapsed');
    }
});

// --- Audio Mixer Logic ---
const mixerBtn = document.getElementById('mixer-btn');
const closeMixerBtn = document.getElementById('close-mixer-btn');
const mixerPanel = document.getElementById('mixer-panel');
const mixerTracks = document.getElementById('mixer-tracks');

// Toggle Mixer Panel
mixerBtn.addEventListener('click', () => {
    mixerPanel.classList.toggle('hidden');
    mixerBtn.style.color = mixerPanel.classList.contains('hidden') ? '' : 'var(--accent)';
});

closeMixerBtn.addEventListener('click', () => {
    mixerPanel.classList.add('hidden');
    mixerBtn.style.color = '';
});

// Function to add a slider to the mixer
function addTrackToMixer(id, label, iconClass, type) {
    if (document.getElementById(`mixer-track-${id}`)) return;

    const trackDiv = document.createElement('div');
    trackDiv.className = 'mixer-track';
    trackDiv.id = `mixer-track-${id}`;

    // The target audio/video element id based on type
    const mediaId = type === 'audio' ? `audio-${id}` : `video-${id}`;

    trackDiv.innerHTML = `
        <span class="mixer-track-name">${label}</span>
        <div class="mixer-track-control">
            <i class="fa-solid ${iconClass}"></i>
            <input type="range" class="vol-slider" min="0" max="1" step="0.01" value="1" oninput="document.getElementById('${mediaId}').volume=this.value">
        </div>
    `;
    mixerTracks.appendChild(trackDiv);
}

function removeTrackFromMixer(id) {
    const trackDiv = document.getElementById(`mixer-track-${id}`);
    if (trackDiv) trackDiv.remove();
}

const PREDEFINED_PROFILES = {
    'Arthur': { id: 'uid_arthur', avatarUrl: 'https://api.dicebear.com/7.x/identicon/svg?seed=Arthur' },
    'Lukas': { id: 'uid_lukas', avatarUrl: 'https://api.dicebear.com/7.x/identicon/svg?seed=Lukas' }
};

let currentUser = {
    id: localStorage.getItem('sc_uid') || null,
    username: localStorage.getItem('sc_username') || '',
    avatarUrl: localStorage.getItem('sc_avatar') || '',
    themeColor: localStorage.getItem('sc_theme') || '#6366f1'
};
let inVoice = false;
let localStream = null;
let screenStream = null;
let voiceMixerActive = false;
let globalPing = 0; // Current ping in ms
let pingIntervalId = null;

// Audio Analyzer Context
let audioContext = null;
const audioAnalyzers = {};

const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

function applyThemeColor(themeOrHex) {
    // Si c'est un ancier code hex, on le force au theme par defaut
    let themeName = themeOrHex && themeOrHex.startsWith('#') ? 'default' : (themeOrHex || 'default');

    document.body.className = ''; // Remove all classes
    document.body.classList.add(`theme-${themeName}`);

    currentUser.themeColor = themeName;
    localStorage.setItem('sc_theme', themeName);

    if (premiumThemeSelector) {
        premiumThemeSelector.querySelectorAll('.theme-card').forEach(card => {
            card.classList.toggle('active', card.dataset.theme === themeName);
        });
    }
}

function initAuth() {
    applyThemeColor(currentUser.themeColor);
}
initAuth();

if (premiumThemeSelector) {
    premiumThemeSelector.querySelectorAll('.theme-card').forEach(card => {
        card.addEventListener('click', () => {
            applyThemeColor(card.dataset.theme);
            if (currentUser.id) {
                socket.emit('user:update-theme', card.dataset.theme);
            }
        });
    });
}

profileCards.forEach(card => {
    card.addEventListener('click', () => {
        const username = card.dataset.username;
        const profile = PREDEFINED_PROFILES[username];
        currentUser.id = profile.id; currentUser.username = username; currentUser.avatarUrl = profile.avatarUrl;
        joinApp();
    });
});

function joinApp() {
    if (!currentUser.id) return;
    localStorage.setItem('sc_uid', currentUser.id);
    localStorage.setItem('sc_username', currentUser.username);
    localStorage.setItem('sc_avatar', currentUser.avatarUrl);

    currentUsernameEl.textContent = currentUser.username;
    if (currentUser.avatarUrl) {
        topAvatar.src = currentUser.avatarUrl; topAvatar.classList.remove('hidden'); topAvatarFallback.classList.add('hidden');
    }

    loginModal.classList.add('hidden'); appContainer.classList.remove('hidden');

    socket.emit('user:join', { userId: currentUser.id, username: currentUser.username, avatarUrl: currentUser.avatarUrl, themeColor: currentUser.themeColor });
    socket.emit('user:update-theme', currentUser.themeColor);

    // Init Audio context on user interaction
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
}

settingsTrigger.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
});

closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
});

socket.on('user:theme-updated', (hexColor) => { applyThemeColor(hexColor); });


function sendMessage() {
    const text = chatInput.value.trim();
    if (text) { socket.emit('chat:message', text); chatInput.value = ''; }
}
sendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

socket.on('chat:history', (messages) => {
    messagesList.innerHTML = ''; messages.forEach(m => appendMessage(m.userId, m.username, m.text, m.timestamp)); scrollToBottom();
});
socket.on('chat:message', (data) => { appendMessage(data.userId, data.username, data.text, data.timestamp); scrollToBottom(); });

// Ping Logic
socket.on('ping:result', (timestamp) => {
    globalPing = Date.now() - timestamp;
});
function startPingLoop() {
    if (pingIntervalId) clearInterval(pingIntervalId);
    pingIntervalId = setInterval(() => {
        socket.emit('ping:measure', Date.now());
    }, 2000);
}
startPingLoop();

function appendMessage(userId, username, text, timestamp) {
    const isMe = userId === currentUser.id;
    const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let avatarSrc = PREDEFINED_PROFILES[username] ? PREDEFINED_PROFILES[username].avatarUrl : 'https://api.dicebear.com/7.x/identicon/svg?seed=' + username;

    const div = document.createElement('div');
    div.className = 'message';
    div.innerHTML = `<img class="msg-avatar" src="${avatarSrc}" alt="">
        <div class="msg-content">
            <div class="msg-header">
                <span class="msg-author" style="color: ${isMe ? 'var(--accent)' : 'var(--text-main)'}">${username}</span>
                <span class="msg-time">${time}</span>
            </div><div class="msg-text">${text}</div>
        </div>`;
    messagesList.appendChild(div);
}
function scrollToBottom() { messagesList.scrollTop = messagesList.scrollHeight; }

function setupAudioAnalysis(id, stream) {
    if (!audioContext) return;
    if (!stream.getAudioTracks().length) return;
    if (audioContext.state === 'suspended') audioContext.resume();

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser); // On ne connecte pas a destination pour eviter le larsen, la video element distant joue deja le son

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const checkVolume = () => {
        if (!audioAnalyzers[id]) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) { sum += dataArray[i]; }
        const average = sum / dataArray.length;

        const avatarWrap = document.getElementById(`voice-avatar-${id}`);
        if (avatarWrap) {
            if (average > 10) avatarWrap.classList.add('is-speaking');
            else avatarWrap.classList.remove('is-speaking');
        }
        audioAnalyzers[id].requestFrame = requestAnimationFrame(checkVolume);
    };
    audioAnalyzers[id] = { analyser, requestFrame: requestAnimationFrame(checkVolume) };
}

function stopAudioAnalysis(id) {
    if (audioAnalyzers[id]) {
        cancelAnimationFrame(audioAnalyzers[id].requestFrame);
        delete audioAnalyzers[id];
    }
}

function updateArenaLayout() {
    const hasVideo = Array.from(videoGrid.children).some(w => w.style.display !== 'none');
    if (hasVideo) {
        videoGrid.style.display = 'flex';
        videoGrid.classList.remove('hidden');
        voiceGrid.style.display = 'none';
        voiceGrid.classList.add('hidden');
        videoSection.classList.remove('hidden');
    } else if (inVoice) {
        videoGrid.style.display = 'none';
        videoGrid.classList.add('hidden');
        voiceGrid.style.display = 'flex';
        voiceGrid.classList.remove('hidden');
        videoSection.classList.remove('hidden');
    } else {
        videoGrid.classList.add('hidden');
        voiceGrid.classList.add('hidden');
        videoSection.classList.add('hidden');
        if (document.fullscreenElement) document.exitFullscreen();
    }
}

function addVoiceAvatar(id, username, stream) {
    let wrap = document.getElementById(`voice-avatar-${id}`);

    // Si l'avatar existe déjà (créé par voice:others ou voice:user-joined avant le flux)
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'voice-avatar-wrapper';
        wrap.id = `voice-avatar-${id}`;
        wrap.dataset.username = username;
        let avatarSrc = PREDEFINED_PROFILES[username] ? PREDEFINED_PROFILES[username].avatarUrl : 'https://api.dicebear.com/7.x/identicon/svg?seed=' + username;

        let audioHtml = '';
        if (id !== 'local') {
            audioHtml = `<audio id="audio-${id}" autoplay></audio>`;
        }

        wrap.innerHTML = `<img src="${avatarSrc}" class="voice-avatar"><span class="voice-name">${username}</span>${audioHtml}`;

        if (id !== 'local') {
            addTrackToMixer(id, username + ' (Micro)', 'fa-microphone', 'audio');
        }
        voiceGrid.appendChild(wrap);
    }

    // Attach stream to existing or new avatar
    if (stream && id !== 'local') {
        const audioEl = document.getElementById(`audio-${id}`);
        if (audioEl && !audioEl.srcObject) {
            audioEl.srcObject = stream;
        }
    }

    updateArenaLayout();
}
function removeVoiceAvatar(id) {
    const wrap = document.getElementById(`voice-avatar-${id}`);
    if (wrap) wrap.remove();
    removeTrackFromMixer(id);
    updateArenaLayout();
}

voiceChannelBtn.addEventListener('click', async () => {
    if (!inVoice) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
            inVoice = true;
            voiceChannelBtn.classList.add('hidden');
            activeVoiceControls.classList.remove('hidden');

            socket.emit('voice:join');

            addVoiceAvatar('local', currentUser.username, localStream);
            setupAudioAnalysis('local', localStream);

        } catch (e) { console.error(e); alert("Accès micro refusé."); }
    }
});

disconnectBtn.addEventListener('click', () => {
    inVoice = false;
    voiceChannelBtn.classList.remove('hidden');
    activeVoiceControls.classList.add('hidden');

    // Clean up all peers first
    Object.keys(peers).forEach(id => {
        stopAudioAnalysis(id);
        removeVoiceAvatar(id);
        if (peers[id] && peers[id].pc) peers[id].pc.close();
        delete peers[id];
    });

    // Clean up local
    stopAudioAnalysis('local');
    removeVoiceAvatar('local');

    // Nuclear fallback: remove ALL voice avatar wrappers from DOM
    document.querySelectorAll('.voice-avatar-wrapper').forEach(el => el.remove());

    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (screenStream) { stopScreenShare(); }

    videoGrid.innerHTML = '';
    socket.emit('voice:leave');
    updateArenaLayout();
});

micBtn.addEventListener('click', () => {
    if (localStream) {
        const track = localStream.getAudioTracks()[0];
        if (track) {
            track.enabled = !track.enabled;
            micBtn.style.color = track.enabled ? '' : 'var(--danger)';
            micBtn.innerHTML = track.enabled ? '<i class="fa-solid fa-microphone"></i>' : '<i class="fa-solid fa-microphone-slash"></i>';
        }
    }
});

screenBtn.addEventListener('click', async () => {
    if (!inVoice) return;
    if (screenStream) { stopScreenShare(); return; }

    try {
        // Optimisation extrême pour le jeu (Valorant) : 1080p, 120fps, et audio pur
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                width: { ideal: 1920, max: 1920 },
                height: { ideal: 1080, max: 1080 },
                frameRate: { ideal: 120, max: 120 }
            },
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false, // On garde le son brut du jeu
                channelCount: 2 // Stéréo pour les bruits de pas
            }
        });

        // Force l'encodeur à privilégier la fluidité (FPS) plutôt que la netteté parfaite s'il y a des baisses de co
        const videoTrack = screenStream.getVideoTracks()[0];
        if ('contentHint' in videoTrack) {
            videoTrack.contentHint = 'motion';
        }

        screenBtn.style.color = 'var(--success)';

        // On affiche un placeholder local, on ne relie pas la source pour couper l'effet miroir/vert.
        addVideoStream('local-screen', currentUser.username + " (Toi)", screenStream, true);

        // Hide local cursor on the video to reduce the infinite mirror cursor effect
        const localVideo = document.getElementById('video-local-screen');
        if (localVideo) {
            localVideo.style.pointerEvents = 'none';
        }

        screenStream.getVideoTracks()[0].onended = stopScreenShare;

        Object.values(peers).forEach(p => {
            const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(screenStream.getVideoTracks()[0]);
            else screenStream.getTracks().forEach(t => p.pc.addTrack(t, screenStream));
        });

        // Trigger manual renegotiation since we added a track
        Object.keys(peers).forEach(socketId => initiateCall(socketId));

    } catch (e) {
        console.error("Partage d'écran annulé.", e);
    }
});

function stopScreenShare() {
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
        screenBtn.style.color = '';
        removeVideoStream('local-screen');

        Object.values(peers).forEach(p => {
            const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) p.pc.removeTrack(sender);
        });
        updateArenaLayout();
    }
}

socket.on('voice:others', (others) => {
    console.log('[VOICE] Received voice:others:', JSON.stringify(others));
    others.forEach(user => {
        if (user.userId === currentUser.id) return;

        // Create avatar immediately
        let labelName = user.username || 'Flux';
        addVoiceAvatar(user.socketId, labelName, null);

        // Create peer and initiate the call (I am the late joiner, I call them)
        const pc = createPeer(user.socketId, user.userId);
        peers[user.socketId] = { pc, userId: user.userId };
        initiateCall(user.socketId);
    });
});

socket.on('voice:user-joined', (data) => {
    console.log('[VOICE] Received voice:user-joined:', JSON.stringify(data));
    if (data.userId === currentUser.id) return;

    // Create avatar immediately 
    let labelName = data.username || 'Flux';
    addVoiceAvatar(data.socketId, labelName, null);

    // Create peer but DON'T initiate call (I am the early joiner, I wait for their offer)
    if (!peers[data.socketId]) {
        const pc = createPeer(data.socketId, data.userId);
        peers[data.socketId] = { pc, userId: data.userId };
    }
});

socket.on('voice:user-left', (sid) => {
    console.log('[VOICE] Received voice:user-left:', sid);
    if (peers[sid]) {
        if (peers[sid].pc) peers[sid].pc.close();
        delete peers[sid];
    }
    removeVideoStream(sid + '-video');
    removeVoiceAvatar(sid);
    stopAudioAnalysis(sid);
    updateArenaLayout();
});

socket.on('voice:offer', async (payload) => {
    console.log('[VOICE] Received offer from:', payload.caller);
    try {
        if (!peers[payload.caller]) {
            const pc = createPeer(payload.caller, payload.userId);
            peers[payload.caller] = { pc, userId: payload.userId };
        }
        const pc = peers[payload.caller].pc;
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice:answer', { target: payload.caller, sdp: pc.localDescription });
        console.log('[VOICE] Sent answer to:', payload.caller);
    } catch (e) {
        console.error('[VOICE] Error handling offer:', e);
    }
});

socket.on('voice:answer', async (payload) => {
    console.log('[VOICE] Received answer from:', payload.caller);
    try {
        if (peers[payload.caller]) {
            await peers[payload.caller].pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        }
    } catch (e) {
        console.error('[VOICE] Error handling answer:', e);
    }
});

socket.on('voice:ice-candidate', async (payload) => {
    if (peers[payload.caller]) {
        try { await peers[payload.caller].pc.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (e) { }
    }
});

function createPeer(targetSocketId, targetUserId) {
    const pc = new RTCPeerConnection(iceServers);

    pc.onicecandidate = e => {
        if (e.candidate) socket.emit('voice:ice-candidate', { target: targetSocketId, candidate: e.candidate });
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[VOICE] ICE state for ${targetSocketId}: ${pc.iceConnectionState}`);
    };

    pc.ontrack = e => {
        let labelName = 'Flux';
        Object.keys(PREDEFINED_PROFILES).forEach(k => { if (PREDEFINED_PROFILES[k].id === targetUserId) labelName = k; });

        if (e.streams && e.streams[0]) {
            const hasVideo = e.streams[0].getVideoTracks().length > 0;
            if (hasVideo) {
                addVideoStream(targetSocketId + '-video', labelName + ' (Stream)', e.streams[0], false);
            } else if (e.track.kind === 'audio') {
                addVoiceAvatar(targetSocketId, labelName, e.streams[0]);
                setupAudioAnalysis(targetSocketId, e.streams[0]);
            }
        }
    };

    // Add local tracks to the connection
    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    if (screenStream) screenStream.getTracks().forEach(t => pc.addTrack(t, screenStream));
    return pc;
}

async function initiateCall(targetSocketId) {
    if (!peers[targetSocketId]) return;
    const pc = peers[targetSocketId].pc;
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('voice:offer', { target: targetSocketId, sdp: pc.localDescription, userId: currentUser.id });
        console.log('[VOICE] Sent offer to:', targetSocketId);
    } catch (e) {
        console.error('[VOICE] Error creating offer:', e);
    }
}

function addVideoStream(id, label, stream, muted) {
    let wrapper = document.getElementById(`video-wrap-${id}`);
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'video-wrapper';
        wrapper.id = `video-wrap-${id}`;

        const video = document.createElement('video');
        video.id = `video-${id}`; video.autoplay = true; video.playsInline = true; video.muted = muted;
        wrapper.appendChild(video);

        const lbl = document.createElement('div');
        lbl.className = 'video-label-wrap';
        lbl.innerHTML = `<span class="video-label-text">${label}</span>`;
        if (id !== 'local-screen') {
            addTrackToMixer(id, label, 'fa-desktop', 'video');
        }

        // Add Stats Overlay (Ping / FPS)
        const statsOverlay = document.createElement('div');
        statsOverlay.className = 'stats-overlay hidden';
        statsOverlay.id = `stats-${id}`;
        statsOverlay.innerHTML = `PING: -- | FPS: --`;

        wrapper.appendChild(lbl);
        wrapper.appendChild(statsOverlay);
        videoGrid.appendChild(wrapper);

        // Setup FPS tracking
        trackVideoFPS(video, statsOverlay);
    }

    if (stream) {
        const vEl = document.getElementById(`video-${id}`);
        if (vEl) {
            vEl.srcObject = stream;
            wrapper.style.display = (stream.getVideoTracks().length === 0) ? 'none' : 'flex';
        }
    } else if (id === 'local-screen') {
        wrapper.style.display = 'flex';
    }
    updateArenaLayout();
}

function removeVideoStream(id) {
    const el = document.getElementById(`video-wrap-${id}`);
    if (el) el.remove();
    removeTrackFromMixer(id);
    updateArenaLayout();
}

// --- YouTube Watch Party Logic ---
const ytToggleBtn = document.getElementById('youtube-toggle-btn');
const ytInputWrap = document.getElementById('youtube-input-wrap');
const ytUrlInput = document.getElementById('youtube-url-input');
const ytLaunchBtn = document.getElementById('youtube-launch-btn');
const ytOverlay = document.getElementById('youtube-overlay');
const closeYtBtn = document.getElementById('close-youtube-btn');

let ytPlayer = null;
let isYtSyncing = false; // Prevents infinite loops when syncing

ytToggleBtn.addEventListener('click', () => {
    ytInputWrap.classList.toggle('hidden');
});

closeYtBtn.addEventListener('click', () => {
    stopYouTube();
    socket.emit('youtube:stop');
});

function extractVideoID(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

ytLaunchBtn.addEventListener('click', () => {
    const url = ytUrlInput.value.trim();
    if (!url) return;
    const videoId = extractVideoID(url);
    if (videoId) {
        startYouTube(videoId);
        socket.emit('youtube:start', videoId);
        ytInputWrap.classList.add('hidden');
        ytUrlInput.value = '';
    } else {
        alert("Lien YouTube invalide.");
    }
});

// Initialize YouTube API completely
function onYouTubeIframeAPIReady() {
    // API is ready, we wait for a start command
}

function startYouTube(videoId) {
    ytOverlay.classList.remove('hidden');
    videoSection.classList.remove('hidden');

    if (ytPlayer) {
        ytPlayer.loadVideoById(videoId);
    } else {
        ytPlayer = new YT.Player('youtube-player-container', {
            height: '100%',
            width: '100%',
            videoId: videoId,
            playerVars: {
                'playsinline': 1,
                'rel': 0
            },
            events: {
                'onReady': onPlayerReady,
                'onStateChange': onPlayerStateChange
            }
        });
    }
}

function stopYouTube() {
    ytOverlay.classList.add('hidden');
    if (ytPlayer && ytPlayer.stopVideo) {
        ytPlayer.stopVideo();
    }
    updateArenaLayout();
}

function onPlayerReady(event) {
    event.target.playVideo();
}

function onPlayerStateChange(event) {
    if (isYtSyncing) return; // Don't emit if it's an external sync affecting us

    // 1 = Playing, 2 = Paused, 3 = Buffering
    if (event.data === YT.PlayerState.PLAYING) {
        socket.emit('youtube:sync', { state: 'play', time: ytPlayer.getCurrentTime() });
    } else if (event.data === YT.PlayerState.PAUSED) {
        socket.emit('youtube:sync', { state: 'pause', time: ytPlayer.getCurrentTime() });
    }
}

// Socket Listeners for YouTube
socket.on('youtube:start', (videoId) => {
    startYouTube(videoId);
});

socket.on('youtube:stop', () => {
    stopYouTube();
});

socket.on('youtube:sync', (data) => {
    if (!ytPlayer || !ytPlayer.seekTo) return;
    isYtSyncing = true;

    const timeDiff = Math.abs(ytPlayer.getCurrentTime() - data.time);
    if (timeDiff > 1) { // Only seek if out of sync by more than 1 second
        ytPlayer.seekTo(data.time, true);
    }

    if (data.state === 'play') {
        ytPlayer.playVideo();
    } else if (data.state === 'pause') {
        ytPlayer.pauseVideo();
    }

    setTimeout(() => { isYtSyncing = false; }, 500); // Re-enable local event emitting after sync
});

// --- FPS Tracking Logic ---
function trackVideoFPS(videoElement, statsElement) {
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return; // Fallback if unsupported

    let lastTime = performance.now();
    let frames = 0;

    const updateFPS = (now, metadata) => {
        frames++;
        if (now - lastTime >= 1000) { // Calculate every second
            const fps = Math.round((frames * 1000) / (now - lastTime));
            updateStatsUI(statsElement, fps);
            frames = 0;
            lastTime = now;
        }
        videoElement.requestVideoFrameCallback(updateFPS);
    };

    videoElement.requestVideoFrameCallback(updateFPS);
}

function updateStatsUI(statsElement, fps) {
    if (!statsElement) return;
    statsElement.classList.remove('hidden');

    let pingClass = 'ping-good';
    if (globalPing > 150) pingClass = 'ping-bad';
    else if (globalPing > 80) pingClass = 'ping-ok';

    statsElement.innerHTML = `PING: <span class="${pingClass}">${globalPing}ms</span> | FPS: ${fps}`;
}
