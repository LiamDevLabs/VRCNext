/* === VR Wrist Overlay === */

let vroConnected   = false;
let vroVisible     = false;
let vroRecording   = false;
let vroKeybindIds  = [];
let vroKeybindNames = [];
let _vroAutoTimer  = null;

// ── State sync from C# ───────────────────────────────────────────────────────

function handleVroState(d) {
    vroConnected    = !!d.connected;
    vroVisible      = !!d.visible;
    vroRecording    = !!d.recording;

    if (d.keybind   !== undefined) vroKeybindIds   = d.keybind   || [];
    if (d.keybindNames !== undefined) vroKeybindNames = d.keybindNames || [];

    const dot  = document.getElementById('vroDot');
    const txt  = document.getElementById('vroStatusText');
    const btn  = document.getElementById('vroConnBtn');
    const badge = document.getElementById('badgeVro');

    if (d.connected) {
        dot?.classList.replace('offline', 'online');
        if (txt) txt.textContent = 'Connected';
        if (txt) txt.style.color = 'var(--ok)';
        if (btn) btn.innerHTML = '<span class="msi" style="font-size:16px;">link_off</span> Disconnect';
        badge?.classList.replace('offline', 'online');
        // Push current resolved colors so the overlay gets the right theme immediately,
        // including auto color. applyColors() will sendToCS overlayThemeColors.
        if (currentSpecialTheme === 'auto') applyAutoColor();
        else if (typeof THEMES !== 'undefined' && THEMES[currentTheme]) applyColors(THEMES[currentTheme].c);
    } else {
        dot?.classList.replace('online', 'offline');
        if (txt) txt.textContent = d.error || 'Not connected';
        if (txt) txt.style.color = d.error ? 'var(--err)' : 'var(--tx3)';
        if (btn) btn.innerHTML = '<span class="msi" style="font-size:16px;">link</span> Connect';
        badge?.classList.replace('online', 'offline');
    }

    const controlCard = document.getElementById('vroControlCard');
    if (controlCard) controlCard.style.display = d.connected ? '' : 'none';

    const showBtn  = document.getElementById('vroShowBtn');
    const hideBtn  = document.getElementById('vroHideBtn');
    if (showBtn) { showBtn.disabled = !d.connected; showBtn.style.opacity = d.connected ? '1' : '0.4'; }
    if (hideBtn) { hideBtn.disabled = !d.connected; hideBtn.style.opacity = d.connected ? '1' : '0.4'; }

    const visIco = document.getElementById('vroVisIcon');
    const visTxt = document.getElementById('vroVisText');
    if (visIco) visIco.textContent = d.visible ? 'visibility_off' : 'visibility';
    if (visTxt) visTxt.textContent = d.visible ? 'Hide Overlay' : 'Show Overlay';

    updateKeybindDisplay();
    updateRecordingUI();

    const leftEl  = document.getElementById('vroCtrlL');
    const rightEl = document.getElementById('vroCtrlR');
    if (leftEl)  leftEl.classList.toggle('detected', !!d.leftController);
    if (rightEl) rightEl.classList.toggle('detected', !!d.rightController);
}

function handleVroKeybindRecorded(d) {
    vroKeybindIds   = d.ids   || [];
    vroKeybindNames = d.names || [];
    vroRecording    = false;
    updateKeybindDisplay();
    updateRecordingUI();
    vroSendConfig();
}

// ── Connect / disconnect ──────────────────────────────────────────────────────

function vroConnect() {
    if (vroConnected) {
        sendToCS({ action: 'vroDisconnect' });
    } else {
        sendToCS({ action: 'vroConnect' });
        vroSendConfig();
    }
}

// ── Show / hide overlay ───────────────────────────────────────────────────────

function vroToggleVisibility() {
    if (!vroConnected) return;
    sendToCS({ action: vroVisible ? 'vroHide' : 'vroShow' });
}

// ── Config ────────────────────────────────────────────────────────────────────

function vroSendConfig() {
    const attachLeft = document.getElementById('vroAttachLeft')?.value === 'left';
    const attachHand = document.getElementById('vroAttachPart')?.value === 'hand';

    sendToCS({
        action:     'vroConfig',
        attachLeft,
        attachHand,
        posX:       parseFloat(document.getElementById('vroPosX')?.value)  || 0,
        posY:       parseFloat(document.getElementById('vroPosY')?.value)  || 0.07,
        posZ:       parseFloat(document.getElementById('vroPosZ')?.value)  || -0.05,
        rotX:       parseFloat(document.getElementById('vroRotX')?.value)  || -80,
        rotY:       parseFloat(document.getElementById('vroRotY')?.value)  || 0,
        rotZ:       parseFloat(document.getElementById('vroRotZ')?.value)  || 0,
        width:      parseFloat(document.getElementById('vroWidth')?.value) || 0.22,
        keybind:    vroKeybindIds
    });
}

function vroAutoSave() {
    vroSendConfig();
    clearTimeout(_vroAutoTimer);
    _vroAutoTimer = setTimeout(() => saveSettings(), 600);
}

function vroAutoSaveSettings() {
    sendToCS({ action: 'vroAutoSave', autoStart: !!document.getElementById('setVroAutoStart')?.checked });
    clearTimeout(_vroAutoTimer);
    _vroAutoTimer = setTimeout(() => saveSettings(), 600);
}

// ── Keybind recording ─────────────────────────────────────────────────────────

function vroStartRecording() {
    if (!vroConnected) return;
    vroRecording = true;
    updateRecordingUI();
    sendToCS({ action: 'vroRecordKeybind' });
}

function vroCancelRecording() {
    vroRecording = false;
    updateRecordingUI();
    sendToCS({ action: 'vroCancelRecording' });
}

function vroClearKeybind() {
    vroKeybindIds   = [];
    vroKeybindNames = [];
    updateKeybindDisplay();
    vroSendConfig();
}

function updateRecordingUI() {
    const recordBtn = document.getElementById('vroRecordBtn');
    const cancelBtn = document.getElementById('vroCancelRecordBtn');
    const hint      = document.getElementById('vroRecordHint');

    if (vroRecording) {
        if (recordBtn) { recordBtn.style.display = 'none'; }
        if (cancelBtn) { cancelBtn.style.display = 'flex'; }
        if (hint)      { hint.textContent = 'Press 2–3 controller buttons simultaneously and hold…'; hint.style.color = 'var(--warn)'; }
    } else {
        if (recordBtn) { recordBtn.style.display = 'flex'; }
        if (cancelBtn) { cancelBtn.style.display = 'none'; }
        if (hint)      { hint.textContent = 'Hold 2–3 controller buttons together to record a combo.'; hint.style.color = 'var(--tx3)'; }
    }
}

function updateKeybindDisplay() {
    const display = document.getElementById('vroKeybindDisplay');
    const visual  = document.getElementById('vroControllerVisual');
    if (!display) return;

    if (vroKeybindNames.length === 0) {
        display.innerHTML = '<span style="color:var(--tx3);font-style:italic;">No keybind set</span>';
    } else {
        display.innerHTML = vroKeybindNames
            .map(n => `<span class="vro-keybind-chip">${n}</span>`)
            .join('<span class="vro-keybind-plus">+</span>');
    }

    if (!visual) return;
    // Update highlighted buttons on the controller SVG
    visual.querySelectorAll('.vro-btn').forEach(el => {
        el.classList.remove('active');
        const btnId = parseInt(el.dataset.btnId ?? '999');
        if (vroKeybindIds.includes(btnId)) el.classList.add('active');
    });
}

// ── Transform value display ───────────────────────────────────────────────────

function vroUpdateTransformLabel(id) {
    const input = document.getElementById(id);
    const label = document.getElementById(id + 'Val');
    if (!input || !label) return;
    label.textContent = parseFloat(input.value).toFixed(2);
}

// ── Load settings from C# ─────────────────────────────────────────────────────

function vroLoadSettings(s) {
    if (!s) return;

    const attachLeftEl = document.getElementById('vroAttachLeft');
    const attachPartEl = document.getElementById('vroAttachPart');
    if (attachLeftEl) attachLeftEl.value = s.vroAttachLeft ? 'left' : 'right';
    if (attachPartEl) attachPartEl.value = s.vroAttachHand ? 'hand' : 'arm';

    const ids = ['vroPosX','vroPosY','vroPosZ','vroRotX','vroRotY','vroRotZ','vroWidth'];
    const keys = ['vroPosX','vroPosY','vroPosZ','vroRotX','vroRotY','vroRotZ','vroWidth'];
    ids.forEach((id, i) => {
        const el = document.getElementById(id);
        if (el && s[keys[i]] !== undefined) {
            el.value = s[keys[i]];
            vroUpdateTransformLabel(id);
        }
    });

    const autoEl = document.getElementById('setVroAutoStart');
    if (autoEl && s.vroAutoStart !== undefined) autoEl.checked = !!s.vroAutoStart;

    vroKeybindIds   = s.vroKeybind   || [];
    vroKeybindNames = s.vroKeybindNames || [];
    updateKeybindDisplay();
}
