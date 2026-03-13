#if WINDOWS
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Valve.VR;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Media.Control;

namespace VRCNext.Services
{
    public class VROverlayService : IDisposable
    {
        // ── Config ────────────────────────────────────────────────────────────
        public bool AttachToLeft   { get; set; } = true;
        public bool AttachToHand   { get; set; } = true;
        public float PosX          { get; set; } = 0.0f;
        public float PosY          { get; set; } = 0.07f;
        public float PosZ          { get; set; } = -0.05f;
        public float RotX          { get; set; } = -80f;
        public float RotY          { get; set; } = 0f;
        public float RotZ          { get; set; } = 0f;
        public float WidthMeters   { get; set; } = 0.22f;
        public List<uint> Keybind  { get; private set; } = new();

        // ── State ─────────────────────────────────────────────────────────────
        public bool IsConnected    { get; private set; }
        public bool IsVisible      { get; private set; }
        public bool IsRecording    { get; private set; }
        public string? LastError   { get; private set; }

        // ── Events ────────────────────────────────────────────────────────────
        public event Action<object>? OnStateUpdate;
        public event Action<List<uint>, List<string>>? OnKeybindRecorded;
        public event Action<int>? OnToolToggle;
        public event Action<string, string>? OnJoinRequest; // (friendId, location)

        // ── OpenVR handles ────────────────────────────────────────────────────
        private CVRSystem? _vrSystem;
        private bool _ownedInit;
        private ulong _overlayHandle;

        // ── Poll loop ─────────────────────────────────────────────────────────
        private CancellationTokenSource? _cts;
        private bool _running;
        private bool _disposed;
        private readonly Action<string> _log;

        // ── Controller tracking ───────────────────────────────────────────────
        private uint _leftIdx  = OpenVR.k_unTrackedDeviceIndexInvalid;
        private uint _rightIdx = OpenVR.k_unTrackedDeviceIndexInvalid;
        private readonly TrackedDevicePose_t[] _poses = new TrackedDevicePose_t[OpenVR.k_unMaxTrackedDeviceCount];

        // ── Keybind recording ─────────────────────────────────────────────────
        private ulong _lastPressedButtons;
        private int   _stableFrames;
        private const int STABLE_FRAMES_REQUIRED = 25; // ~275ms at 11ms poll

        // Event-driven button state — updated from VREvent_ButtonPress/Unpress,
        // which fire even while the Steam overlay is open (unlike GetControllerState).
        private ulong _eventButtonsHeld = 0;
        private bool  _keybindTriggered = false;    // prevents repeated toggle while combo held
        private int   _keybindReleaseFrames = 0;    // frames the combo has been NOT held
        private const int KEYBIND_RELEASE_REQUIRED = 30; // ~330ms stable release before re-arm

        // ── D3D11 (staging + overlay textures for flicker-free upload) ────────
        // Valve docs & openvr#772: use Texture2D.NativePointer + CopyResource + Flush,
        // NOT SetOverlayRaw (shockingly inefficient, causes blank frame each call).
        private ID3D11Device?        _d3dDevice;
        private ID3D11DeviceContext? _d3dContext;
        private ID3D11Texture2D?     _stagingTex;  // CPU-writable staging buffer
        private ID3D11Texture2D?     _overlayTex;  // GPU texture SteamVR reads from

        // ── Rendering ─────────────────────────────────────────────────────────
        private Bitmap?   _bitmap;
        private const int W = 512;
        private const int H = 384;
        // Preallocated RGBA pixel buffer for CPU→staging copy
        private readonly byte[] _uploadBuf = new byte[W * H * 4];
        // SMTC poll — query media session every ~3 s (270 × 11 ms)
        private int  _smtcTick = 0;
        private bool _smtcPolling = false;
        private const int SMTC_POLL_INTERVAL = 270;
        // Local position interpolation — avoids re-rendering every second
        private double   _mediaPositionAtPoll = 0;
        private DateTime _mediaLastPollTime   = DateTime.MinValue;
        private int      _lastDisplayedSecond = -1;
        // Cached SMTC session for media control commands
        private GlobalSystemMediaTransportControlsSession? _smtcSession;
        // Track last controller index that a valid transform was applied for
        private uint _lastTransformIdx = OpenVR.k_unTrackedDeviceIndexInvalid;

        // ── Profile image cache (notification avatars) ────────────────────────
        private readonly Dictionary<string, Bitmap?> _notifImgCache = new();
        private readonly System.Net.Http.HttpClient  _httpImgClient = new() { Timeout = TimeSpan.FromSeconds(5) };

        // ── Join button cooldowns (friendId → click time) ─────────────────────
        private readonly Dictionary<string, DateTime> _joinCooldowns = new();

        // ── Material Symbols Rounded font (downloaded once, used for tool icons) ─
        private System.Drawing.Text.PrivateFontCollection? _matSymFonts;
        private FontFamily? _matSymFamily;

        // ── Album art (SMTC thumbnail) ────────────────────────────────────────
        private Bitmap? _albumArt;

        // ── Proximity interaction ─────────────────────────────────────────────
        // Free hand < ENTER_DIST from wrist → Mouse mode + interactive flag on.
        // Free hand > LEAVE_DIST            → back to None (hysteresis prevents flicker).
        private bool  _interactMode      = false;
        private const float INTERACT_ENTER_DIST = 0.28f; // 28 cm
        private const float INTERACT_LEAVE_DIST = 0.36f; // 36 cm

        // ── Overlay content ───────────────────────────────────────────────────
        private int                   _activeTab = 0; // 0=Notifications 1=Music 2=Tools
        private readonly List<NotifEntry> _notifications = new();
        private string   _mediaTitle    = "";
        private string   _mediaArtist   = "";
        private double   _mediaDuration = 0;
        private bool     _mediaPlaying  = false;
        private bool     _dirty         = true;

        // ── Tool states ───────────────────────────────────────────────────────
        private bool _toolDiscord  = false;
        private bool _toolVoice    = false;
        private bool _toolYtFix    = false;
        private bool _toolSpaceFlt = false;
        private bool _toolRelay    = false;
        private bool _toolChatbox  = false;

        public void SetToolStates(bool discord, bool voiceFight, bool ytFix, bool spaceFlight, bool relay, bool chatbox)
        {
            _toolDiscord  = discord;
            _toolVoice    = voiceFight;
            _toolYtFix    = ytFix;
            _toolSpaceFlt = spaceFlight;
            _toolRelay    = relay;
            _toolChatbox  = chatbox;
            _dirty = true;
        }

        // ── Button name maps ──────────────────────────────────────────────────
        private static readonly Dictionary<uint, string> ButtonNames = new()
        {
            { (uint)EVRButtonId.k_EButton_System,          "System"    },
            { (uint)EVRButtonId.k_EButton_ApplicationMenu, "Menu"      },
            { (uint)EVRButtonId.k_EButton_Grip,            "Grip"      },
            { (uint)EVRButtonId.k_EButton_A,               "A"         },
            { (uint)EVRButtonId.k_EButton_Axis0,           "Thumbstick"},
            { (uint)EVRButtonId.k_EButton_Axis1,           "Trigger"   },
        };

        private record NotifEntry(string EvType, string FriendName, string EvText, string Time, string ImageUrl = "", string FriendId = "", string Location = "");

        // ── Theme colors ──────────────────────────────────────────────────────
        private OverlayTheme _theme = OverlayTheme.FromName("midnight");

        public void SetTheme(string name)
        {
            _theme = OverlayTheme.FromName(name);
            _dirty = true;
        }

        /// <summary>Called from JS applyColors — handles both named themes and auto color.</summary>
        public void SetThemeColors(Dictionary<string, string> colors)
        {
            _theme = OverlayTheme.FromColors(colors);
            _dirty = true;
        }

        public readonly struct OverlayTheme
        {
            public Color BgCard  { get; init; }
            public Color BgHover { get; init; }
            public Color Accent  { get; init; }
            public Color Ok      { get; init; }
            public Color Warn    { get; init; }
            public Color Err     { get; init; }
            public Color Cyan    { get; init; }
            public Color Tx1     { get; init; }
            public Color Tx2     { get; init; }
            public Color Tx3     { get; init; }
            public Color Brd     { get; init; }

            public static OverlayTheme FromName(string n) =>
                _palettes.TryGetValue(n ?? "midnight", out var t) ? t : _palettes["midnight"];

            public static OverlayTheme FromColors(Dictionary<string, string> c)
            {
                Color G(string k) => c.TryGetValue(k, out var v) ? H(v) : Color.Transparent;
                return new OverlayTheme
                {
                    BgCard  = G("bg-card"),
                    BgHover = G("bg-hover"),
                    Accent  = G("accent"),
                    Ok      = G("ok"),
                    Warn    = G("warn"),
                    Err     = G("err"),
                    Cyan    = G("cyan"),
                    Tx1     = G("tx1"),
                    Tx2     = G("tx2"),
                    Tx3     = G("tx3"),
                    Brd     = G("brd"),
                };
            }

            private static Color H(string hex) =>
                Color.FromArgb(255,
                    Convert.ToInt32(hex[1..3], 16),
                    Convert.ToInt32(hex[3..5], 16),
                    Convert.ToInt32(hex[5..7], 16));

            private static readonly Dictionary<string, OverlayTheme> _palettes = new()
            {
                ["midnight"]   = new() { BgCard=H("#0F1628"),BgHover=H("#141E37"),Accent=H("#3884FF"),Ok=H("#2DD48C"),Warn=H("#FFBA37"),Err=H("#FF4B55"),Cyan=H("#00D2EB"),Tx1=H("#DCE4F5"),Tx2=H("#788CAF"),Tx3=H("#41506E"),Brd=H("#1C2841") },
                ["ocean"]      = new() { BgCard=H("#082233"),BgHover=H("#0C2E44"),Accent=H("#0EA5E9"),Ok=H("#34D399"),Warn=H("#FBBF24"),Err=H("#F87171"),Cyan=H("#22D3EE"),Tx1=H("#BAE6FD"),Tx2=H("#7DD3FC"),Tx3=H("#3B7EA1"),Brd=H("#164E63") },
                ["emerald"]    = new() { BgCard=H("#0C2018"),BgHover=H("#12301F"),Accent=H("#10B981"),Ok=H("#4ADE80"),Warn=H("#FCD34D"),Err=H("#FB7185"),Cyan=H("#2DD4BF"),Tx1=H("#BBF7D0"),Tx2=H("#6EE7B7"),Tx3=H("#3D7A5A"),Brd=H("#1A4034") },
                ["sunset"]     = new() { BgCard=H("#1E1008"),BgHover=H("#2D1A0C"),Accent=H("#F97316"),Ok=H("#84CC16"),Warn=H("#FCD34D"),Err=H("#EF4444"),Cyan=H("#22D3EE"),Tx1=H("#FEF3C7"),Tx2=H("#FDBA74"),Tx3=H("#7C4D28"),Brd=H("#431C08") },
                ["rose"]       = new() { BgCard=H("#1E0A12"),BgHover=H("#2D1220"),Accent=H("#F43F5E"),Ok=H("#34D399"),Warn=H("#FBBF24"),Err=H("#FB7185"),Cyan=H("#22D3EE"),Tx1=H("#FFE4E6"),Tx2=H("#FDA4AF"),Tx3=H("#7C2D42"),Brd=H("#4C0519") },
                ["lavender"]   = new() { BgCard=H("#16122A"),BgHover=H("#1E1840"),Accent=H("#A78BFA"),Ok=H("#34D399"),Warn=H("#FCD34D"),Err=H("#F87171"),Cyan=H("#67E8F9"),Tx1=H("#EDE9FE"),Tx2=H("#C4B5FD"),Tx3=H("#5B4E8A"),Brd=H("#2E2660") },
                ["vrchat"]     = new() { BgCard=H("#1C1C2C"),BgHover=H("#26263C"),Accent=H("#7C3AED"),Ok=H("#2DD48C"),Warn=H("#FFBA37"),Err=H("#FF4B55"),Cyan=H("#00D2EB"),Tx1=H("#E2E2F0"),Tx2=H("#9898B0"),Tx3=H("#484865"),Brd=H("#2E2E50") },
                ["day"]        = new() { BgCard=H("#F0F4FF"),BgHover=H("#E2EAFF"),Accent=H("#3884FF"),Ok=H("#16A34A"),Warn=H("#D97706"),Err=H("#DC2626"),Cyan=H("#0891B2"),Tx1=H("#1E2A3A"),Tx2=H("#4B5A6F"),Tx3=H("#9CA3B0"),Brd=H("#CBD5E8") },
                ["night"]      = new() { BgCard=H("#0A0A0F"),BgHover=H("#111118"),Accent=H("#6366F1"),Ok=H("#22C55E"),Warn=H("#EAB308"),Err=H("#EF4444"),Cyan=H("#06B6D4"),Tx1=H("#E2E8F0"),Tx2=H("#64748B"),Tx3=H("#334155"),Brd=H("#1E293B") },
                ["iris"]       = new() { BgCard=H("#0E0E20"),BgHover=H("#16163A"),Accent=H("#818CF8"),Ok=H("#34D399"),Warn=H("#FCD34D"),Err=H("#F87171"),Cyan=H("#67E8F9"),Tx1=H("#E0E7FF"),Tx2=H("#A5B4FC"),Tx3=H("#4338CA"),Brd=H("#312E81") },
                ["glacier"]    = new() { BgCard=H("#0E1B22"),BgHover=H("#152833"),Accent=H("#38BDF8"),Ok=H("#34D399"),Warn=H("#FCD34D"),Err=H("#F87171"),Cyan=H("#22D3EE"),Tx1=H("#E0F2FE"),Tx2=H("#7DD3FC"),Tx3=H("#164E63"),Brd=H("#0C4A6E") },
                ["petal"]      = new() { BgCard=H("#1F0F1A"),BgHover=H("#2E1728"),Accent=H("#EC4899"),Ok=H("#34D399"),Warn=H("#FCD34D"),Err=H("#F87171"),Cyan=H("#67E8F9"),Tx1=H("#FCE7F3"),Tx2=H("#F9A8D4"),Tx3=H("#831843"),Brd=H("#500724") },
                ["void"]       = new() { BgCard=H("#070707"),BgHover=H("#0D0D0D"),Accent=H("#A78BFA"),Ok=H("#2DD48C"),Warn=H("#FFBA37"),Err=H("#FF4B55"),Cyan=H("#00D2EB"),Tx1=H("#CCCCCC"),Tx2=H("#666666"),Tx3=H("#333333"),Brd=H("#1A1A1A") },
                ["dusk"]       = new() { BgCard=H("#181024"),BgHover=H("#241840"),Accent=H("#C084FC"),Ok=H("#4ADE80"),Warn=H("#FCD34D"),Err=H("#F87171"),Cyan=H("#67E8F9"),Tx1=H("#F3E8FF"),Tx2=H("#D8B4FE"),Tx3=H("#6B21A8"),Brd=H("#4C1D95") },
                ["ultraviolet"]= new() { BgCard=H("#0A0015"),BgHover=H("#150025"),Accent=H("#9333EA"),Ok=H("#22C55E"),Warn=H("#EAB308"),Err=H("#EF4444"),Cyan=H("#06B6D4"),Tx1=H("#FAF5FF"),Tx2=H("#D8B4FE"),Tx3=H("#581C87"),Brd=H("#3B0764") },
                ["plum"]       = new() { BgCard=H("#160C20"),BgHover=H("#221232"),Accent=H("#D946EF"),Ok=H("#34D399"),Warn=H("#FCD34D"),Err=H("#F87171"),Cyan=H("#67E8F9"),Tx1=H("#FDF4FF"),Tx2=H("#F0ABFC"),Tx3=H("#701A75"),Brd=H("#4A044E") },
                ["periwinkle"] = new() { BgCard=H("#0E1228"),BgHover=H("#161C3A"),Accent=H("#6D83EF"),Ok=H("#6EE7B7"),Warn=H("#FCD34D"),Err=H("#FCA5A5"),Cyan=H("#93C5FD"),Tx1=H("#EEF2FF"),Tx2=H("#A5B4FC"),Tx3=H("#3730A3"),Brd=H("#312E81") },
            };
        }

        // ─────────────────────────────────────────────────────────────────────

        public VROverlayService(Action<string> log) => _log = log;

        // ── Public API ────────────────────────────────────────────────────────

        public bool Connect()
        {
            if (IsConnected) return true;
            LastError = null;

            try
            {
                if (OpenVR.System == null)
                {
                    var err = EVRInitError.None;
                    _vrSystem = OpenVR.Init(ref err, EVRApplicationType.VRApplication_Overlay);
                    if (err != EVRInitError.None)
                    {
                        err = EVRInitError.None;
                        try { OpenVR.Shutdown(); } catch { }
                        _vrSystem = OpenVR.Init(ref err, EVRApplicationType.VRApplication_Background);
                        if (err != EVRInitError.None)
                        {
                            LastError = $"OpenVR init failed: {err}";
                            _log($"[VROverlay] {LastError}");
                            return false;
                        }
                    }
                    _ownedInit = true;
                    _log("[VROverlay] OpenVR initialized");
                }
                else
                {
                    _vrSystem = OpenVR.System;
                    _ownedInit = false;
                    _log("[VROverlay] Reusing existing OpenVR session");
                }

                if (OpenVR.Overlay == null)
                {
                    LastError = "IVROverlay not available";
                    _log($"[VROverlay] {LastError}");
                    return false;
                }

                // Create world (non-dashboard) overlay
                var oErr = OpenVR.Overlay.CreateOverlay("vrcnext.wristoverlay", "VRCNext Wrist", ref _overlayHandle);
                if (oErr == EVROverlayError.KeyInUse)
                {
                    OpenVR.Overlay.FindOverlay("vrcnext.wristoverlay", ref _overlayHandle);
                    _log("[VROverlay] Found existing overlay handle");
                }
                else if (oErr != EVROverlayError.None)
                {
                    LastError = $"CreateOverlay: {oErr}";
                    _log($"[VROverlay] {LastError}");
                    return false;
                }

                OpenVR.Overlay.SetOverlayWidthInMeters(_overlayHandle, WidthMeters);
                OpenVR.Overlay.SetOverlayAlpha(_overlayHandle, 0.97f);
                // Start non-interactive; proximity detection switches to Mouse when
                // the free hand gets close to the wrist, then back to None on leave.
                OpenVR.Overlay.SetOverlayInputMethod(_overlayHandle, VROverlayInputMethod.None);
                var mouseScale = new HmdVector2_t { v0 = W, v1 = H };
                OpenVR.Overlay.SetOverlayMouseScale(_overlayHandle, ref mouseScale);

                _bitmap = new Bitmap(W, H, PixelFormat.Format32bppArgb);

                // D3D11: staging (CPU-writable) + overlay (GPU, SteamVR reads from it).
                // Pattern from ValveSoftware/openvr#772 and #1353:
                //   Map staging → write pixels → Unmap → CopyResource → SetOverlayTexture → Flush
                // CopyResource is GPU-atomic; SteamVR compositor never sees a partial write.
                // Handle = ID3D11Texture2D.NativePointer (COM ptr), NOT SRV.
                try
                {
                    D3D11.D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.None,
                        [FeatureLevel.Level_11_0, FeatureLevel.Level_10_1],
                        out _d3dDevice, out _d3dContext);

                    // Overlay texture: GPU-only, SteamVR reads from it each compositor frame
                    var overlayDesc = new Texture2DDescription
                    {
                        Width = W, Height = H, MipLevels = 1, ArraySize = 1,
                        Format = Format.R8G8B8A8_UNorm,   // RGBA — safest for SteamVR
                        SampleDescription = new SampleDescription(1, 0),
                        Usage = ResourceUsage.Default,
                        BindFlags = BindFlags.ShaderResource,
                    };
                    _overlayTex = _d3dDevice!.CreateTexture2D(overlayDesc);

                    // Staging texture: CPU-writable, source for CopyResource
                    var stagingDesc = new Texture2DDescription
                    {
                        Width = W, Height = H, MipLevels = 1, ArraySize = 1,
                        Format = Format.R8G8B8A8_UNorm,
                        SampleDescription = new SampleDescription(1, 0),
                        Usage = ResourceUsage.Staging,
                        CPUAccessFlags = CpuAccessFlags.Write,
                    };
                    _stagingTex = _d3dDevice.CreateTexture2D(stagingDesc);
                    _log("[VROverlay] D3D11 staging+overlay textures ready");
                }
                catch (Exception ex)
                {
                    _log($"[VROverlay] D3D11 init failed (SetOverlayRaw fallback): {ex.Message}");
                    _d3dDevice = null; _d3dContext = null; _stagingTex = null; _overlayTex = null;
                }

                UpdateControllerIndices();
                ApplyTransform();

                IsConnected = true;
                _dirty = true;
                _log("[VROverlay] Connected");
                return true;
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
                _log($"[VROverlay] Connect error: {ex.Message}");
                return false;
            }
        }

        public void Disconnect()
        {
            StopPolling();
            if (!IsConnected) return;

            if (_overlayHandle != 0 && OpenVR.Overlay != null)
            {
                try
                {
                    OpenVR.Overlay.HideOverlay(_overlayHandle);
                    OpenVR.Overlay.DestroyOverlay(_overlayHandle);
                }
                catch { }
                _overlayHandle = 0;
            }

            if (_ownedInit)
            {
                try { OpenVR.Shutdown(); } catch { }
                _ownedInit = false;
            }

            _bitmap?.Dispose();     _bitmap     = null;
            _stagingTex?.Dispose(); _stagingTex  = null;
            _overlayTex?.Dispose(); _overlayTex  = null;
            _d3dContext?.Dispose(); _d3dContext   = null;
            _d3dDevice?.Dispose();  _d3dDevice    = null;
            _albumArt?.Dispose();   _albumArt     = null;
            lock (_notifImgCache)
            {
                foreach (var bmp in _notifImgCache.Values) bmp?.Dispose();
                _notifImgCache.Clear();
            }

            IsConnected = false;
            IsVisible   = false;
            _vrSystem   = null;
            _log("[VROverlay] Disconnected");
        }

        public void StartPolling()
        {
            if (_running) return;
            _cts     = new CancellationTokenSource();
            _running = true;
            _ = PollLoopAsync(_cts.Token);
            _ = Task.Run(EnsureMaterialSymbolsAsync);
        }

        private async Task EnsureMaterialSymbolsAsync()
        {
            if (_matSymFamily != null) return;
            string cacheDir  = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCNext");
            string fontPath  = Path.Combine(cacheDir, "MaterialSymbolsRounded.ttf");
            if (!File.Exists(fontPath))
            {
                try
                {
                    Directory.CreateDirectory(cacheDir);
                    using var http  = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(30) };
                    var bytes = await http.GetByteArrayAsync(
                        "https://github.com/google/material-design-icons/raw/master/variablefont/MaterialSymbolsRounded%5BFILL%2CGRAD%2Copsz%2Cwght%5D.ttf");
                    await File.WriteAllBytesAsync(fontPath, bytes);
                    _log("[VROverlay] Downloaded Material Symbols Rounded font");
                }
                catch (Exception ex) { _log($"[VROverlay] Font download failed: {ex.Message}"); return; }
            }
            try
            {
                var pfc = new System.Drawing.Text.PrivateFontCollection();
                pfc.AddFontFile(fontPath);
                _matSymFonts  = pfc;
                _matSymFamily = pfc.Families[0];
                _log($"[VROverlay] Loaded font: {_matSymFamily.Name}");
                _dirty = true;
            }
            catch (Exception ex) { _log($"[VROverlay] Font load failed: {ex.Message}"); }
        }

        public void StopPolling()
        {
            _running = false;
            _cts?.Cancel();
        }

        public void Show()
        {
            if (!IsConnected || OpenVR.Overlay == null) return;
            ApplyTransform();
            // Render the first frame BEFORE ShowOverlay so SteamVR never displays
            // a blank/white overlay — this prevents the initial flash/flicker.
            _dirty = true;
            Render();
            OpenVR.Overlay.ShowOverlay(_overlayHandle);
            IsVisible = true;
            EmitState();
        }

        public void Hide()
        {
            if (!IsConnected || OpenVR.Overlay == null) return;
            DisableInteract(); // always exit interact mode when hiding
            OpenVR.Overlay.HideOverlay(_overlayHandle);
            IsVisible = false;
            _lastTransformIdx = OpenVR.k_unTrackedDeviceIndexInvalid; // re-apply on next Show()
            EmitState();
        }

        public void Toggle()
        {
            if (IsVisible) Hide(); else Show();
        }

        public void SetActiveTab(int tab)
        {
            _activeTab = tab;
            _dirty = true;
        }

        public void ApplyConfig(bool attachLeft, bool attachHand,
            float px, float py, float pz,
            float rx, float ry, float rz,
            float width, List<uint> keybind)
        {
            AttachToLeft  = attachLeft;
            AttachToHand  = attachHand;
            PosX = px; PosY = py; PosZ = pz;
            RotX = rx; RotY = ry; RotZ = rz;
            WidthMeters   = Math.Clamp(width, 0.05f, 1.0f);
            Keybind       = keybind ?? new();

            if (IsConnected && OpenVR.Overlay != null)
            {
                OpenVR.Overlay.SetOverlayWidthInMeters(_overlayHandle, WidthMeters);
                ApplyTransform();
            }
        }

        public void AddNotification(string evType, string friendName, string evText, string time, string imageUrl = "", string friendId = "", string location = "")
        {
            lock (_notifications)
            {
                var entry = new NotifEntry(evType, friendName, evText, time, imageUrl, friendId, location);
                int existing = _notifications.FindIndex(n => n.EvType == evType && n.FriendName == friendName);
                if (existing >= 0)
                    _notifications[existing] = entry;
                else
                {
                    _notifications.Insert(0, entry);
                    while (_notifications.Count > 4) _notifications.RemoveAt(_notifications.Count - 1);
                }
            }
            if (!string.IsNullOrEmpty(imageUrl))
                _ = Task.Run(() => EnsureNotifImageAsync(imageUrl));
            _dirty = true;
        }

        private async Task EnsureNotifImageAsync(string url)
        {
            lock (_notifImgCache) { if (_notifImgCache.ContainsKey(url)) return; }
            try
            {
                var bytes = await _httpImgClient.GetByteArrayAsync(url);
                using var ms = new System.IO.MemoryStream(bytes);
                var bmp = new Bitmap(ms);
                lock (_notifImgCache) { _notifImgCache[url] = bmp; }
                _dirty = true;
            }
            catch
            {
                lock (_notifImgCache) { _notifImgCache[url] = null; }
            }
        }

        public void UpdateMediaInfo(string title, string artist, double position, double duration, bool playing)
        {
            _mediaTitle          = title;
            _mediaArtist         = artist;
            _mediaPositionAtPoll = position;
            _mediaLastPollTime   = DateTime.UtcNow;
            _mediaDuration       = duration;
            _mediaPlaying        = playing;
            _lastDisplayedSecond = -1;
            _dirty = true;
        }

        private double GetCurrentMediaPosition()
        {
            if (!_mediaPlaying || _mediaLastPollTime == DateTime.MinValue)
                return _mediaPositionAtPoll;
            return _mediaPositionAtPoll + (DateTime.UtcNow - _mediaLastPollTime).TotalSeconds;
        }

        private async Task PollSmtcAsync()
        {
            try
            {
                var mgr = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
                var s = mgr.GetCurrentSession();
                if (s == null)
                {
                    _smtcSession = null;
                    if (_mediaTitle != "") { _mediaTitle = ""; _mediaArtist = ""; _mediaPlaying = false; _dirty = true; }
                    return;
                }
                _smtcSession = s;

                var playing = s.GetPlaybackInfo()?.PlaybackStatus ==
                              GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
                var props = await s.TryGetMediaPropertiesAsync();
                var title  = props?.Title  ?? "";
                var artist = props?.Artist ?? "";
                var tl  = s.GetTimelineProperties();
                var pos = tl?.Position.TotalSeconds ?? 0;
                var dur = tl != null ? (tl.EndTime - tl.StartTime).TotalSeconds : 0;

                // Record anchor for local interpolation
                _mediaPositionAtPoll = pos;
                _mediaLastPollTime   = DateTime.UtcNow;
                _mediaDuration       = dur;

                bool trackChanged = title != _mediaTitle || artist != _mediaArtist;
                if (trackChanged || playing != _mediaPlaying)
                {
                    _mediaTitle   = title;
                    _mediaArtist  = artist;
                    _mediaPlaying = playing;
                    _lastDisplayedSecond = -1;
                    _dirty = true;
                }

                // Fetch album art when track changes
                if (trackChanged && props?.Thumbnail != null)
                {
                    try
                    {
                        using var ras    = await props.Thumbnail.OpenReadAsync();
                        using var stream = ras.AsStreamForRead();
                        var newArt = new Bitmap(stream);
                        _albumArt?.Dispose();
                        _albumArt = newArt;
                        _dirty    = true;
                    }
                    catch { _albumArt?.Dispose(); _albumArt = null; }
                }
                else if (trackChanged)
                {
                    _albumArt?.Dispose();
                    _albumArt = null;
                }
            }
            catch { }
        }

        private void SendSmtcCommand(string cmd)
        {
            var session = _smtcSession;
            if (session == null) return;
            _ = Task.Run(async () =>
            {
                try
                {
                    switch (cmd)
                    {
                        case "prev": await session.TrySkipPreviousAsync(); break;
                        case "next": await session.TrySkipNextAsync();     break;
                        case "playpause":
                            var status = session.GetPlaybackInfo()?.PlaybackStatus;
                            if (status == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                                await session.TryPauseAsync();
                            else
                                await session.TryPlayAsync();
                            break;
                    }
                    // Refresh metadata immediately after command
                    await Task.Delay(300);
                    await PollSmtcAsync();
                    _dirty = true;
                }
                catch { }
            });
        }

        public void StartKeybindRecording()
        {
            IsRecording         = true;
            _stableFrames       = 0;
            _lastPressedButtons = 0;
            _eventButtonsHeld   = 0; // clear stale state so nothing fires immediately
            _log("[VROverlay] Keybind recording started");
            EmitState();
        }

        public void StopKeybindRecording()
        {
            IsRecording = false;
            EmitState();
        }

        // ── Private helpers ────────────────────────────────────────────────────

        /// <summary>
        /// Measures distance between the wrist controller and the free (opposite) hand.
        /// Under INTERACT_ENTER_DIST → enables Mouse input + MakeOverlaysInteractiveIfVisible
        /// so SteamVR shows a laser pointer and routes click events to the overlay.
        /// Over INTERACT_LEAVE_DIST  → reverts to None so the game gets all input back.
        /// Hysteresis prevents flickering at the boundary.
        /// </summary>
        private void UpdateProximityInteract()
        {
            if (!IsVisible || _vrSystem == null || OpenVR.Overlay == null || _overlayHandle == 0) return;

            var wristIdx = AttachToLeft ? _leftIdx : _rightIdx;
            var freeIdx  = AttachToLeft ? _rightIdx : _leftIdx;

            if (wristIdx == OpenVR.k_unTrackedDeviceIndexInvalid ||
                freeIdx  == OpenVR.k_unTrackedDeviceIndexInvalid)
            {
                if (_interactMode) DisableInteract();
                return;
            }

            _vrSystem.GetDeviceToAbsoluteTrackingPose(
                ETrackingUniverseOrigin.TrackingUniverseStanding, 0f, _poses);

            if (!_poses[wristIdx].bPoseIsValid || !_poses[freeIdx].bPoseIsValid)
            {
                if (_interactMode) DisableInteract();
                return;
            }

            var wm = _poses[wristIdx].mDeviceToAbsoluteTracking;
            var fm = _poses[freeIdx].mDeviceToAbsoluteTracking;
            // Translation is in the last column: m3, m7, m11
            var wristPos = new Vector3(wm.m3, wm.m7, wm.m11);
            var freePos  = new Vector3(fm.m3, fm.m7, fm.m11);

            float dist = Vector3.Distance(wristPos, freePos);

            if (!_interactMode && dist < INTERACT_ENTER_DIST)
            {
                _interactMode = true;
                OpenVR.Overlay.SetOverlayInputMethod(_overlayHandle, VROverlayInputMethod.Mouse);
                OpenVR.Overlay.SetOverlayFlag(_overlayHandle,
                    VROverlayFlags.MakeOverlaysInteractiveIfVisible, true);
            }
            else if (_interactMode && dist > INTERACT_LEAVE_DIST)
            {
                DisableInteract();
            }
        }

        private void DisableInteract()
        {
            _interactMode = false;
            if (OpenVR.Overlay == null || _overlayHandle == 0) return;
            OpenVR.Overlay.SetOverlayFlag(_overlayHandle,
                VROverlayFlags.MakeOverlaysInteractiveIfVisible, false);
            OpenVR.Overlay.SetOverlayInputMethod(_overlayHandle, VROverlayInputMethod.None);
        }

        private async Task PollLoopAsync(CancellationToken ct)
        {
            _log("[VROverlay] Poll loop started");
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    PollEvents();
                    UpdateControllerIndices();

                    if (IsRecording)
                        PollKeybindRecording();
                    else
                        PollKeybindTrigger();

                    // Poll SMTC in background so the loop is never blocked by WinRT await
                    if (++_smtcTick >= SMTC_POLL_INTERVAL && !_smtcPolling)
                    {
                        _smtcTick    = 0;
                        _smtcPolling = true;
                        _ = Task.Run(async () => { try { await PollSmtcAsync(); } finally { _smtcPolling = false; } });
                    }

                    // Proximity-based interaction: enable Mouse+Interactive when free
                    // hand is near the wrist, revert to None otherwise.
                    UpdateProximityInteract();

                    if (IsVisible)
                    {
                        // Re-apply transform if the active controller index just became
                        // valid or changed (e.g. controller connected after Show() was called).
                        var curIdx = AttachToLeft ? _leftIdx : _rightIdx;
                        if (curIdx != OpenVR.k_unTrackedDeviceIndexInvalid && curIdx != _lastTransformIdx)
                        {
                            _lastTransformIdx = curIdx;
                            ApplyTransform();
                        }

                        // For the music player tab, re-render only when the displayed second
                        // actually changes — avoids calling SetOverlayRaw every tick.
                        if (_activeTab == 1 && _mediaPlaying)
                        {
                            int sec = (int)GetCurrentMediaPosition();
                            if (sec != _lastDisplayedSecond)
                            {
                                _lastDisplayedSecond = sec;
                                _dirty = true;
                            }
                        }

                        // Mark dirty while any join cooldown is still active (so button resets after 5s)
                        if (_joinCooldowns.Count > 0)
                        {
                            var now = DateTime.UtcNow;
                            bool anyCooldownActive = false;
                            bool anyCooldownExpired = false;
                            foreach (var kv in _joinCooldowns)
                            {
                                double elapsed = (now - kv.Value).TotalSeconds;
                                if (elapsed < 5) anyCooldownActive = true;
                                else anyCooldownExpired = true;
                            }
                            if (anyCooldownExpired)
                            {
                                var expired = new List<string>();
                                foreach (var kv in _joinCooldowns)
                                    if ((now - kv.Value).TotalSeconds >= 5) expired.Add(kv.Key);
                                foreach (var k in expired) _joinCooldowns.Remove(k);
                                _dirty = true;
                            }
                            else if (anyCooldownActive)
                            {
                                _dirty = true;
                            }
                        }

                        // Only upload a new texture when content actually changed.
                        if (_dirty)
                        {
                            _dirty = false;
                            Render();
                        }
                    }

                    await Task.Delay(11, ct);
                }
                catch (TaskCanceledException) { break; }
                catch (Exception ex)
                {
                    _log($"[VROverlay] PollLoop: {ex.Message}");
                    await Task.Delay(500, ct);
                }
            }
            _running = false;
        }

        private void PollEvents()
        {
            if (_vrSystem == null) return;
            var evt = new VREvent_t();
            var evtSize = (uint)Marshal.SizeOf<VREvent_t>();

            // Drain system-level events.
            // VREvent_ButtonPress / VREvent_ButtonUnpress arrive here even when
            // the Steam overlay is open — unlike GetControllerState which returns
            // zeroes while Steam holds exclusive input focus.
            while (_vrSystem.PollNextEvent(ref evt, evtSize))
            {
                var eType = (EVREventType)evt.eventType;
                if (eType == EVREventType.VREvent_ButtonPress)
                {
                    _eventButtonsHeld |= 1UL << (int)evt.data.controller.button;
                }
                else if (eType == EVREventType.VREvent_ButtonUnpress)
                {
                    _eventButtonsHeld &= ~(1UL << (int)evt.data.controller.button);
                }
            }

            // Drain overlay-specific events (laser pointer mouse interactions).
            // Also mirror ButtonPress/Unpress into _eventButtonsHeld so keybind detection
            // works even when the overlay is interactive/focused and events route here
            // instead of PollNextEvent.
            if (OpenVR.Overlay != null && _overlayHandle != 0)
            {
                while (OpenVR.Overlay.PollNextOverlayEvent(_overlayHandle, ref evt, evtSize))
                {
                    var oType = (EVREventType)evt.eventType;
                    if (oType == EVREventType.VREvent_ButtonPress)
                    {
                        _eventButtonsHeld |= 1UL << (int)evt.data.controller.button;
                    }
                    else if (oType == EVREventType.VREvent_ButtonUnpress)
                    {
                        _eventButtonsHeld &= ~(1UL << (int)evt.data.controller.button);
                    }
                    else if (oType == EVREventType.VREvent_MouseButtonDown)
                    {
                        var mu = evt.data.mouse;
                        float nx = mu.x / W;
                        float ny = mu.y / H;   // OpenVR: y=0 at bottom, y=H at top
                        HandleOverlayClick(nx, ny);
                    }
                }
            }
        }

        private void HandleOverlayClick(float nx, float ny)
        {
            // Tab bar: GDI+ y=8–58 → OpenVR ny ≈ 0.85–0.98 (y=0 at bottom)
            // 3 tabs, each ~165px: thirds at nx 0.34 and 0.67
            if (ny > 0.84f)
            {
                _activeTab = nx < 0.34f ? 0 : nx < 0.67f ? 1 : 2;
                _lastDisplayedSecond = -1;
                _dirty = true;
                return;
            }

            // Music player controls (new layout):
            //   artBottom=206, barY=268, barH=6, ctrlCY=312, W=512, H=384
            //   OpenVR y=0 at bottom → ny=(H-gdiy)/H
            //   Controls GDI+ y 286–338 → ny 0.12–0.25
            //   Prev  cx=172 ±18 → nx 0.27–0.40
            //   Play  cx=256 ±26 → nx 0.43–0.57
            //   Next  cx=340 ±18 → nx 0.60–0.73
            if (_activeTab == 1 && ny >= 0.11f && ny <= 0.27f)
            {
                if      (nx >= 0.27f && nx <= 0.40f) SendSmtcCommand("prev");
                else if (nx >= 0.43f && nx <= 0.57f) SendSmtcCommand("playpause");
                else if (nx >= 0.60f && nx <= 0.73f) SendSmtcCommand("next");
            }

            // Tools tab card clicks — same constants as DrawTools
            if (_activeTab == 2)
            {
                const int startY = 76, gap = 8, padX = 12;
                int cardW = (W - padX * 2 - gap) / 2;
                int cardH = (H - startY - padX - gap * 2) / 3;
                int gdix  = (int)(nx * W);
                int gdiy  = (int)((1f - ny) * H);
                int col   = (gdix - padX) / (cardW + gap);
                int row   = (gdiy - startY) / (cardH + gap);
                if (col >= 0 && col < 2 && row >= 0 && row < 3)
                {
                    // Verify click is inside the card (not in the gap)
                    int localX = (gdix - padX) % (cardW + gap);
                    int localY = (gdiy - startY) % (cardH + gap);
                    if (localX < cardW && localY < cardH)
                        OnToolToggle?.Invoke(row * 2 + col);
                }
            }

            // Notifications tab join button clicks
            // Square button: jbW = h-4 = itemH-4-4 = 70px, jbX = x+w-jbW-2 = 12+488-70-2 = 428
            if (_activeTab == 0)
            {
                const int contentY2 = 72, itemH2 = 78;
                int gdix2 = (int)(nx * W);
                int gdiy2 = (int)((1f - ny) * H);
                // jbX = 12 + (W-24) - (itemH2-4-4) - 2 = W - 86; right edge = W - 12 - 2 = W-14
                if (gdix2 >= W - 86 && gdix2 <= W - 14)
                {
                    int row2 = (gdiy2 - contentY2) / itemH2;
                    if (row2 >= 0 && row2 < 4)
                    {
                        int itemGdiY2 = contentY2 + row2 * itemH2;
                        if (gdiy2 >= itemGdiY2 && gdiy2 <= itemGdiY2 + itemH2 - 4)
                        {
                            List<NotifEntry> snapJ;
                            lock (_notifications) snapJ = new List<NotifEntry>(_notifications);
                            if (row2 < snapJ.Count && snapJ[row2].EvType == "friend_gps" && !string.IsNullOrEmpty(snapJ[row2].Location))
                            {
                                var notif = snapJ[row2];
                                bool inCooldown = _joinCooldowns.TryGetValue(notif.FriendId, out var cd)
                                    && (DateTime.UtcNow - cd).TotalSeconds < 5;
                                if (!inCooldown)
                                {
                                    _joinCooldowns[notif.FriendId] = DateTime.UtcNow;
                                    _dirty = true;
                                    OnJoinRequest?.Invoke(notif.FriendId, notif.Location);
                                }
                            }
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Merges GetControllerState (reliable when Steam overlay is closed) with
        /// _eventButtonsHeld (from VREvent_ButtonPress, reliable when Steam overlay
        /// is open). Using both sources covers both cases.
        /// </summary>
        private ulong GetMergedButtonState()
        {
            // Start with the event-driven state accumulated in PollEvents().
            ulong state = _eventButtonsHeld;

            if (_vrSystem == null) return state;

            // Also poll GetControllerState — works when Steam overlay is NOT open.
            // When the overlay IS open, this returns 0, so the merge is harmless.
            var s  = new VRControllerState_t();
            var sz = (uint)Marshal.SizeOf<VRControllerState_t>();
            if (_leftIdx != OpenVR.k_unTrackedDeviceIndexInvalid)
                if (_vrSystem.GetControllerState(_leftIdx, ref s, sz))
                    state |= s.ulButtonPressed;
            if (_rightIdx != OpenVR.k_unTrackedDeviceIndexInvalid)
                if (_vrSystem.GetControllerState(_rightIdx, ref s, sz))
                    state |= s.ulButtonPressed;

            return state;
        }

        private void PollKeybindRecording()
        {
            ulong pressed = GetMergedButtonState();
            int bitCount  = CountBits(pressed);

            if (bitCount >= 2 && pressed == _lastPressedButtons)
            {
                _stableFrames++;
                if (_stableFrames >= STABLE_FRAMES_REQUIRED)
                    FinishKeybindRecording(pressed);
            }
            else
            {
                _lastPressedButtons = pressed;
                _stableFrames = 0;
            }
        }

        private void PollKeybindTrigger()
        {
            if (Keybind.Count == 0) return;

            ulong mask = 0;
            foreach (var b in Keybind) mask |= 1UL << (int)b;

            bool allHeld = mask != 0 && (GetMergedButtonState() & mask) == mask;

            if (allHeld)
            {
                _keybindReleaseFrames = 0; // reset release counter while held

                if (!_keybindTriggered)
                {
                    _keybindTriggered = true;
                    Toggle();
                }
            }
            else
            {
                // Require the combo to be stably released for KEYBIND_RELEASE_REQUIRED
                // frames before re-arming. Prevents flicker during Steam overlay open/close
                // where GetControllerState briefly returns 0 between frames.
                _keybindReleaseFrames++;
                if (_keybindReleaseFrames >= KEYBIND_RELEASE_REQUIRED)
                {
                    _keybindTriggered = false;
                    _keybindReleaseFrames = 0;
                }
            }
        }

        private void FinishKeybindRecording(ulong pressed)
        {
            IsRecording = false;
            _stableFrames = 0;

            var ids = new List<uint>();
            var names = new List<string>();
            for (int b = 0; b < 64; b++)
            {
                if ((pressed & (1UL << b)) != 0)
                {
                    var id = (uint)b;
                    ids.Add(id);
                    names.Add(ButtonNames.TryGetValue(id, out var n) ? n : $"Button{b}");
                }
            }

            Keybind = ids;
            _log($"[VROverlay] Keybind recorded: {string.Join("+", names)}");
            OnKeybindRecorded?.Invoke(ids, names);
            EmitState();
        }

        private static int CountBits(ulong v)
        {
            int c = 0;
            while (v != 0) { c += (int)(v & 1); v >>= 1; }
            return c;
        }

        private void UpdateControllerIndices()
        {
            if (_vrSystem == null) return;
            _leftIdx  = _vrSystem.GetTrackedDeviceIndexForControllerRole(ETrackedControllerRole.LeftHand);
            _rightIdx = _vrSystem.GetTrackedDeviceIndexForControllerRole(ETrackedControllerRole.RightHand);
        }

        private void ApplyTransform()
        {
            if (!IsConnected || OpenVR.Overlay == null || _overlayHandle == 0) return;

            var idx = AttachToLeft ? _leftIdx : _rightIdx;
            if (idx == OpenVR.k_unTrackedDeviceIndexInvalid) return;

            var transform = BuildTransform(PosX, PosY, PosZ, RotX, RotY, RotZ);
            OpenVR.Overlay.SetOverlayTransformTrackedDeviceRelative(_overlayHandle, idx, ref transform);
        }

        private static HmdMatrix34_t BuildTransform(float px, float py, float pz, float rxDeg, float ryDeg, float rzDeg)
        {
            var m = Matrix4x4.CreateFromYawPitchRoll(
                ryDeg * MathF.PI / 180f,
                rxDeg * MathF.PI / 180f,
                rzDeg * MathF.PI / 180f);
            return new HmdMatrix34_t
            {
                m0 = m.M11, m1 = m.M12, m2 = m.M13, m3 = px,
                m4 = m.M21, m5 = m.M22, m6 = m.M23, m7 = py,
                m8 = m.M31, m9 = m.M32, m10 = m.M33, m11 = pz
            };
        }

        private void EmitState()
        {
            OnStateUpdate?.Invoke(new
            {
                connected  = IsConnected,
                visible    = IsVisible,
                recording  = IsRecording,
                keybind    = Keybind,
                keybindNames = GetKeybindNames(),
                leftController  = _leftIdx  != OpenVR.k_unTrackedDeviceIndexInvalid,
                rightController = _rightIdx != OpenVR.k_unTrackedDeviceIndexInvalid,
                error      = LastError
            });
        }

        private List<string> GetKeybindNames()
        {
            var names = new List<string>();
            foreach (var id in Keybind)
                names.Add(ButtonNames.TryGetValue(id, out var n) ? n : $"Button{id}");
            return names;
        }

        // ── Rendering ─────────────────────────────────────────────────────────

        private void Render()
        {
            if (_bitmap == null || OpenVR.Overlay == null || _overlayHandle == 0) return;
            try
            {
                using var g = Graphics.FromImage(_bitmap);
                g.SmoothingMode      = SmoothingMode.AntiAlias;
                g.TextRenderingHint  = TextRenderingHint.ClearTypeGridFit;
                g.InterpolationMode  = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.Clear(Color.Transparent);

                DrawBackground(g);
                DrawTabBar(g);
                if      (_activeTab == 0) DrawNotifications(g);
                else if (_activeTab == 1) DrawMusicPlayer(g);
                else                      DrawTools(g);

                UploadTexture();
            }
            catch (Exception ex)
            {
                _log($"[VROverlay] Render: {ex.Message}");
            }
        }

        private void DrawBackground(Graphics g)
        {
            var th = _theme;
            const int r = 24;

            bool hasArt = _activeTab == 1 && _albumArt != null && !string.IsNullOrWhiteSpace(_mediaTitle);

            if (hasArt)
            {
                // ── Music tab: blurred art fills entire card ──────────────────
                // Clip drawing to rounded card shape
                using var cardClip = RoundedRectPath(0, 0, W, H, r);
                var oldClip = g.Clip;
                g.SetClip(cardClip);

                // Downscale → upscale = cheap blur
                using var tiny = new Bitmap(64, 48);
                using (var tg = Graphics.FromImage(tiny))
                {
                    tg.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
                    tg.DrawImage(_albumArt!, 0, 0, 64, 48);
                }
                var prevMode = g.InterpolationMode;
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(tiny, new Rectangle(0, 0, W, H));
                g.InterpolationMode = prevMode;

                // Dark overlay — 50% darker so UI elements stay readable
                using var darkOver = new SolidBrush(Color.FromArgb(110, 0, 0, 0));
                g.FillRectangle(darkOver, 0, 0, W, H);

                // Top gradient: solid bg-card → transparent, ends just above cover art (artY=78)
                // Keeps tab buttons legible while art bleeds through below
                using var topGrad = new System.Drawing.Drawing2D.LinearGradientBrush(
                    new Point(0, 0), new Point(0, 78),
                    Color.FromArgb(220, th.BgCard),
                    Color.FromArgb(0,   th.BgCard));
                g.FillRectangle(topGrad, 0, 0, W, 78);

                // Bottom gradient: transparent → dark, starts just below cover art (artBottom=206)
                using var botGrad = new System.Drawing.Drawing2D.LinearGradientBrush(
                    new Point(0, 206), new Point(0, H),
                    Color.FromArgb(0,   th.BgCard),
                    Color.FromArgb(180, th.BgCard));
                g.FillRectangle(botGrad, 0, 206, W, H - 206);

                g.SetClip(oldClip, System.Drawing.Drawing2D.CombineMode.Replace);
            }
            else
            {
                // ── All other tabs: solid themed card ─────────────────────────
                using var brush = new SolidBrush(Color.FromArgb(235, th.BgCard));
                FillRoundedRect(g, brush, 0, 0, W, H, r);
            }

            // Card border always on top
            using var pen = new Pen(Color.FromArgb(80, th.Brd), 1.5f);
            DrawRoundedRect(g, pen, 1, 1, W - 2, H - 2, r - 1);
        }

        private void DrawTabBar(Graphics g)
        {
            var th = _theme;
            int tabH  = 50;
            int tabX  = 8;
            int tabTW = W - 16;           // total usable width
            int tabW  = tabTW / 3;        // each tab width

            bool artBg = _activeTab == 1 && _albumArt != null && !string.IsNullOrWhiteSpace(_mediaTitle);
            if (!artBg)
            {
                using var tabBg = new SolidBrush(Color.FromArgb(50, th.BgHover));
                FillRoundedRect(g, tabBg, tabX, 8, tabTW, tabH, 14);
            }

            DrawTab(g, "Alerts",  0, tabX,           8, tabW,          tabH);
            DrawTab(g, "Music",   1, tabX + tabW,     8, tabW,          tabH);
            DrawTab(g, "Tools",   2, tabX + tabW * 2, 8, tabTW - tabW * 2, tabH);

            if (!artBg)
            {
                using var sep = new Pen(Color.FromArgb(60, th.Brd), 1f);
                g.DrawLine(sep, 12, 8 + tabH + 2, W - 12, 8 + tabH + 2);
            }
        }

        private void DrawTab(Graphics g, string label, int index, int x, int y, int w, int h)
        {
            var th = _theme;
            bool active = _activeTab == index;
            if (active)
            {
                using var activeBg = new SolidBrush(Color.FromArgb(200, th.Accent));
                FillRoundedRect(g, activeBg, x + 2, y + 2, w - 4, h - 4, 12);
            }

            using var font = new Font("Segoe UI", 10.5f, active ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Point);
            using var brush = new SolidBrush(active ? Color.White : Color.FromArgb(180, th.Tx2));
            var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString(label, font, brush, new RectangleF(x, y, w, h), fmt);
        }

        private void DrawTools(Graphics g)
        {
            var th = _theme;
            const int startY = 76;
            const int gap    = 8;
            const int padX   = 12;
            int cardW = (W - padX * 2 - gap) / 2;
            int cardH = (H - startY - padX - gap * 2) / 3;

            // Layout: 2 cols × 3 rows
            // Icons: Material Symbols Rounded codepoints — 1:1 same as sidebar
            // sensors=\uE51E  mic=\uE31D  smart_display=\uF06A  rocket_launch=\uEB9B  cell_tower=\uEBBA  chat=\uE0C9
            var tools = new (string Icon, string Label, bool Active)[]
            {
                ("\uE51E", "Discord Presence", _toolDiscord),
                ("\uE31D", "Voice Fight",      _toolVoice),
                ("\uF06A", "YouTube Fix",      _toolYtFix),
                ("\uEB9B", "Space Flight",     _toolSpaceFlt),
                ("\uEBBA", "Media Relay",      _toolRelay),
                ("\uE0C9", "Custom Chatbox",   _toolChatbox),
            };

            for (int i = 0; i < tools.Length; i++)
            {
                int col = i % 2;
                int row = i / 2;
                int x   = padX + col * (cardW + gap);
                int y   = startY + row * (cardH + gap);
                DrawToolCard(g, tools[i].Icon, tools[i].Label, tools[i].Active, x, y, cardW, cardH);
            }
        }

        private void DrawToolCard(Graphics g, string icon, string label, bool active, int x, int y, int w, int h)
        {
            var th = _theme;

            // Card background
            if (active)
            {
                using var bg = new SolidBrush(Color.FromArgb(55, th.Accent));
                FillRoundedRect(g, bg, x, y, w, h, 10);
                using var border = new Pen(Color.FromArgb(130, th.Accent), 1.5f);
                DrawRoundedRect(g, border, x, y, w, h, 10);
            }
            else
            {
                using var bg = new SolidBrush(Color.FromArgb(35, th.BgHover));
                FillRoundedRect(g, bg, x, y, w, h, 10);
                using var border = new Pen(Color.FromArgb(45, th.Brd), 1f);
                DrawRoundedRect(g, border, x, y, w, h, 10);
            }

            // Icon — Material Symbols Rounded (same font as sidebar), fallback to Segoe MDL2 Assets
            int iconH = (int)(h * 0.58f);
            using var iconFont  = _matSymFamily != null
                ? new Font(_matSymFamily, 20f, FontStyle.Regular, GraphicsUnit.Point)
                : new Font("Segoe MDL2 Assets", 20f, FontStyle.Regular, GraphicsUnit.Point);
            using var iconBrush = new SolidBrush(active ? th.Accent : Color.FromArgb(110, th.Tx2));
            var iconFmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString(icon, iconFont, iconBrush, new RectangleF(x, y, w, iconH), iconFmt);

            // Label (bottom ~45%)
            int labelY = y + iconH;
            int labelH = h - iconH;
            using var nameFont  = new Font("Segoe UI", 8.5f, active ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Point);
            using var nameBrush = new SolidBrush(active ? Color.White : Color.FromArgb(130, th.Tx2));
            var nameFmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center,
                                             Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap };
            g.DrawString(label, nameFont, nameBrush, new RectangleF(x + 4, labelY, w - 8, labelH), nameFmt);

            // Status dot (top-right corner)
            int dotR = 5;
            int dotX = x + w - dotR * 2 - 5;
            int dotY = y + 5;
            using var dotBr = new SolidBrush(active ? th.Ok : Color.FromArgb(70, th.Tx3));
            g.FillEllipse(dotBr, dotX, dotY, dotR * 2, dotR * 2);
        }

        private void DrawNotifications(Graphics g)
        {
            int contentY = 72;
            int contentH = H - contentY - 12;
            int itemH    = contentH / 4;

            List<NotifEntry> snap;
            lock (_notifications) snap = new List<NotifEntry>(_notifications);

            if (snap.Count == 0)
            {
                using var font = new Font("Segoe UI", 11f, FontStyle.Regular, GraphicsUnit.Point);
                using var brush = new SolidBrush(_theme.Tx3);
                var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.DrawString("No recent notifications", font, brush,
                    new RectangleF(12, contentY, W - 24, contentH), fmt);
                return;
            }

            for (int i = 0; i < Math.Min(4, snap.Count); i++)
            {
                var entry = snap[i];
                int iy = contentY + i * itemH;
                DrawNotificationItem(g, entry, 12, iy, W - 24, itemH - 4);
            }
        }

        private void DrawNotificationItem(Graphics g, NotifEntry entry, int x, int y, int w, int h)
        {
            var th       = _theme;
            var evColor  = EventColor(entry.EvType);
            bool hasJoin = entry.EvType == "friend_gps" && !string.IsNullOrEmpty(entry.Location);

            // ── Card background (matches sidebar bg-card) ─────────────────────
            using var bg = new SolidBrush(Color.FromArgb(190, th.BgCard));
            FillRoundedRect(g, bg, x, y, w, h, 8);

            // ── Join button — square (width = height), right edge of card ─────
            int jbW = h - 4;   // square: width equals height (h minus 2px top+bottom margin)
            int jbX = x + w - jbW - 2;
            if (hasJoin)
            {
                bool inCooldown = _joinCooldowns.TryGetValue(entry.FriendId, out var cdTime)
                    && (DateTime.UtcNow - cdTime).TotalSeconds < 5;
                var jbBgColor = inCooldown ? Color.FromArgb(170, th.Ok) : Color.FromArgb(210, th.Accent);
                using var jbBg = new SolidBrush(jbBgColor);
                FillRoundedRect(g, jbBg, jbX, y + 2, jbW, h - 4, 6);
                // Icon: login (\uE879 Material Symbols = door with arrow) for join
                //       done  (\uE876 Material Symbols = checkmark) for sent cooldown
                string icon = inCooldown ? "\uE876" : "\uE879";
                using var iconFont = _matSymFamily != null
                    ? new Font(_matSymFamily, 16f, FontStyle.Regular, GraphicsUnit.Point)
                    : new Font("Segoe MDL2 Assets", 14f, FontStyle.Regular, GraphicsUnit.Point);
                using var iconBrush = new SolidBrush(Color.White);
                var iconFmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.DrawString(icon, iconFont, iconBrush, new RectangleF(jbX, y + 2, jbW, h - 4), iconFmt);
            }

            // ── Avatar — 32×32 rounded square (8px radius), like sidebar ──────
            const int avSize = 32, avR = 8;
            int avX = x + 8;
            int avY = y + (h - avSize) / 2;

            Bitmap? avatar = null;
            if (!string.IsNullOrEmpty(entry.ImageUrl))
                lock (_notifImgCache) { _notifImgCache.TryGetValue(entry.ImageUrl, out avatar); }

            var avRect  = new Rectangle(avX, avY, avSize, avSize);
            var oldClip = g.Clip;
            using var avPath = RoundedRectPath(avX, avY, avSize, avSize, avR);
            g.SetClip(avPath);
            if (avatar != null)
            {
                g.DrawImage(avatar, avRect);
            }
            else
            {
                using var avBg = new SolidBrush(th.BgHover);
                g.FillPath(avBg, avPath);
                g.ResetClip();
                string initials = entry.FriendName.Length > 0 ? entry.FriendName[0].ToString().ToUpper() : "?";
                using var initFont  = new Font("Segoe UI", 13f, FontStyle.Bold, GraphicsUnit.Point);
                using var initBrush = new SolidBrush(th.Tx2);
                var initFmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.DrawString(initials, initFont, initBrush, new RectangleF(avX, avY, avSize, avSize), initFmt);
            }
            g.SetClip(oldClip, System.Drawing.Drawing2D.CombineMode.Replace);

            // ── Text area layout ──────────────────────────────────────────────
            // textX: start after avatar + 8px gap (matches sidebar gap)
            // textRight: stop before join button (or right margin 8px)
            int textX     = avX + avSize + 8;
            int textRight = hasJoin ? jbX - 6 : x + w - 8;

            // Two-row vertical centering
            // Row 1: time · dot · name   (~15px)
            // Row 2: event text          (~13px)
            // Gap between rows: 3px
            const float row1H = 15f, row2H = 13f, rowGap = 3f;
            float row1Y = y + (h - row1H - rowGap - row2H) / 2f;
            float row2Y = row1Y + row1H + rowGap;

            // ── Row 1: Time · Dot · Name ──────────────────────────────────────
            using var timeFont  = new Font("Segoe UI", 7.5f, FontStyle.Regular, GraphicsUnit.Point);
            using var timeBrush = new SolidBrush(th.Tx3);
            var timeSz = g.MeasureString(entry.Time, timeFont);
            float timeW = timeSz.Width;

            // Time
            g.DrawString(entry.Time, timeFont, timeBrush,
                new RectangleF(textX, row1Y, timeW, row1H));

            // Status dot (7px filled circle, event color)
            const float dotSz = 7f;
            float dotX = textX + timeW + 5f;
            float dotY = row1Y + (row1H - dotSz) / 2f;
            using var dotBrush = new SolidBrush(evColor);
            g.FillEllipse(dotBrush, dotX, dotY, dotSz, dotSz);

            // Name (bold, truncated)
            float nameX = dotX + dotSz + 5f;
            float nameW = Math.Max(textRight - nameX, 10f);
            using var nameFont  = new Font("Segoe UI", 10f, FontStyle.Bold, GraphicsUnit.Point);
            using var nameBrush = new SolidBrush(th.Tx1);
            var ellipsisFmt = new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap };
            g.DrawString(entry.FriendName, nameFont, nameBrush,
                new RectangleF(nameX, row1Y, nameW, row1H), ellipsisFmt);

            // ── Row 2: Event text ─────────────────────────────────────────────
            string evText = EventBadgeLabel(entry.EvType, entry.EvText);
            using var evFont  = new Font("Segoe UI", 8.5f, FontStyle.Regular, GraphicsUnit.Point);
            using var evBrush = new SolidBrush(th.Tx3);
            var evFmt = new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap };
            g.DrawString(evText, evFont, evBrush,
                new RectangleF(textX, row2Y, Math.Max(textRight - textX, 10f), row2H), evFmt);
        }

        private Color EventColor(string evType) => evType switch
        {
            "friend_online"     => _theme.Ok,
            "friend_offline"    => _theme.Tx3,
            "friend_gps"        => _theme.Accent,
            "friend_status"     => _theme.Warn,
            "friend_statusdesc" => _theme.Cyan,
            "friend_bio"        => _theme.Cyan,
            "friend_added"      => _theme.Ok,
            "friend_removed"    => _theme.Err,
            _                   => _theme.Tx2,
        };

        private static string EventBadgeLabel(string evType, string evText) => evType switch
        {
            "friend_online"     => "Came online",
            "friend_offline"    => "Went offline",
            "friend_gps"        => evText,          // "→ World Name"
            "friend_status"     => evText,          // "Active → Join Me"
            "friend_statusdesc" => "Status text",
            "friend_bio"        => "Bio",
            "friend_added"      => "Friend added",
            "friend_removed"    => "Removed",
            _                   => evText,
        };

        private void DrawMusicPlayer(Graphics g)
        {
            var th        = _theme;
            const int tabBottom = 68;
            const int pad       = 18;

            bool hasMedia = !string.IsNullOrWhiteSpace(_mediaTitle);

            if (!hasMedia)
            {
                using var font  = new Font("Segoe UI", 11f, FontStyle.Regular, GraphicsUnit.Point);
                using var brush = new SolidBrush(th.Tx3);
                var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.DrawString("No media playing", font, brush,
                    new RectangleF(pad, tabBottom, W - pad * 2, H - tabBottom - pad), fmt);
                return;
            }

            // Background is drawn by DrawBackground() — no duplicate here.

            // ── Layout constants ──────────────────────────────────────────────
            const int artSize = 128;
            int artX = (W - artSize) / 2;   // centered
            int artY = tabBottom + 10;

            // ── Album art (centered, rounded) ─────────────────────────────────
            if (_albumArt != null)
            {
                var artRect = new Rectangle(artX, artY, artSize, artSize);
                using var artPath = RoundedRectPath(artX, artY, artSize, artSize, 14);
                var oldClip = g.Clip;
                g.SetClip(artPath);
                g.DrawImage(_albumArt, artRect);
                g.SetClip(oldClip, System.Drawing.Drawing2D.CombineMode.Replace);
            }
            else
            {
                using var artBg = new SolidBrush(Color.FromArgb(70, th.BgHover));
                FillRoundedRect(g, artBg, artX, artY, artSize, artSize, 14);
                using var noteFnt = new Font("Segoe UI", 36f, FontStyle.Regular, GraphicsUnit.Point);
                using var noteBr  = new SolidBrush(Color.FromArgb(80, th.Tx2));
                var noteFmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                g.DrawString("♫", noteFnt, noteBr, new RectangleF(artX, artY, artSize, artSize), noteFmt);
            }

            int artBottom = artY + artSize;

            // ── Title + Artist (centered below art) ───────────────────────────
            var ellipsisFmt = new StringFormat { Trimming = StringTrimming.EllipsisCharacter,
                                                  FormatFlags = StringFormatFlags.NoWrap,
                                                  Alignment = StringAlignment.Center };

            using var titleFont  = new Font("Segoe UI", 13f, FontStyle.Bold, GraphicsUnit.Point);
            using var titleBrush = new SolidBrush(Color.White);
            g.DrawString(_mediaTitle, titleFont, titleBrush,
                new RectangleF(pad, artBottom + 8, W - pad * 2, 26), ellipsisFmt);

            if (!string.IsNullOrWhiteSpace(_mediaArtist))
            {
                using var artistFont  = new Font("Segoe UI", 10f, FontStyle.Regular, GraphicsUnit.Point);
                using var artistBrush = new SolidBrush(Color.FromArgb(200, th.Tx2));
                g.DrawString(_mediaArtist, artistFont, artistBrush,
                    new RectangleF(pad, artBottom + 36, W - pad * 2, 20), ellipsisFmt);
            }

            // ── Progress bar ──────────────────────────────────────────────────
            int barY = artBottom + 62;
            int barH = 6;
            int barX = pad + 4;
            int barW = W - (barX + pad + 4);

            double curPos = GetCurrentMediaPosition();
            float  prog   = _mediaDuration > 0 ? (float)(curPos / _mediaDuration) : 0f;
            prog = Math.Clamp(prog, 0f, 1f);

            // Track
            using var trackBr = new SolidBrush(Color.FromArgb(55, th.Tx2));
            FillRoundedRect(g, trackBr, barX, barY, barW, barH, barH / 2);
            // Fill
            if (prog > 0)
            {
                int fillW = Math.Max(barH, (int)(barW * prog));
                using var fillBr = new SolidBrush(th.Accent);
                FillRoundedRect(g, fillBr, barX, barY, fillW, barH, barH / 2);
                // Knob
                int knobX = barX + fillW - 6;
                int knobY = barY - 3;
                using var knobBr = new SolidBrush(Color.White);
                g.FillEllipse(knobBr, knobX, knobY, 12, 12);
            }

            // Time labels
            string posStr = FormatTime(curPos);
            string durStr = FormatTime(_mediaDuration);
            using var timeFnt = new Font("Segoe UI", 8f, FontStyle.Regular, GraphicsUnit.Point);
            using var timeBr  = new SolidBrush(Color.FromArgb(160, th.Tx2));
            g.DrawString(posStr, timeFnt, timeBr,
                new RectangleF(barX, barY + barH + 4, 55, 15),
                new StringFormat { Alignment = StringAlignment.Near });
            g.DrawString(durStr, timeFnt, timeBr,
                new RectangleF(barX + barW - 55, barY + barH + 4, 55, 15),
                new StringFormat { Alignment = StringAlignment.Far });

            // ── Controls ──────────────────────────────────────────────────────
            // Play button: large filled accent circle, center at (W/2, ctrlCY)
            // Prev/Next: smaller, subtle bg circle
            int ctrlCY = barY + barH + 38;   // center Y of all controls
            int ctrlCX = W / 2;
            const int playR  = 26;            // play circle radius
            const int skipR  = 18;            // skip circle radius
            const int skipGap = 84;           // center-to-center from play

            // Prev button
            DrawSkipButton(g, th, ctrlCX - skipGap, ctrlCY, skipR, prev: true);
            // Play/Pause button
            DrawPlayButton(g, th, ctrlCX, ctrlCY, playR, _mediaPlaying);
            // Next button
            DrawSkipButton(g, th, ctrlCX + skipGap, ctrlCY, skipR, prev: false);
        }

        private void DrawPlayButton(Graphics g, OverlayTheme th, int cx, int cy, int r, bool playing)
        {
            // Filled accent circle
            using var bgBr = new SolidBrush(th.Accent);
            g.FillEllipse(bgBr, cx - r, cy - r, r * 2, r * 2);
            // White icon drawn as GDI+ shapes
            if (playing)
            {
                // Pause: two white rounded bars
                int bw = 6, bh = (int)(r * 0.85f), bx1 = cx - bw - 3, bx2 = cx + 3;
                int by = cy - bh / 2;
                using var wb = new SolidBrush(Color.White);
                FillRoundedRect(g, wb, bx1, by, bw, bh, 3);
                FillRoundedRect(g, wb, bx2, by, bw, bh, 3);
            }
            else
            {
                // Play: white filled triangle shifted right slightly
                int th2 = (int)(r * 0.75f);
                var pts = new PointF[]
                {
                    new(cx - th2 / 2 + 2, cy - th2),
                    new(cx - th2 / 2 + 2, cy + th2),
                    new(cx + th2 + 2,      cy),
                };
                using var wb = new SolidBrush(Color.White);
                g.FillPolygon(wb, pts);
            }
        }

        private void DrawSkipButton(Graphics g, OverlayTheme th, int cx, int cy, int r, bool prev)
        {
            // Subtle semi-transparent circle
            using var bgBr = new SolidBrush(Color.FromArgb(60, th.BgHover));
            g.FillEllipse(bgBr, cx - r, cy - r, r * 2, r * 2);
            using var border = new Pen(Color.FromArgb(40, th.Brd), 1f);
            g.DrawEllipse(border, cx - r, cy - r, r * 2, r * 2);

            using var wb = new SolidBrush(Color.FromArgb(220, Color.White));
            int tw = (int)(r * 0.52f); // triangle half-height
            int tx = prev ? cx + 2 : cx - 2;

            if (prev)
            {
                // Bar on left, triangle pointing left
                g.FillRectangle(wb, tx - tw - 4, cy - tw, 3, tw * 2);
                var pts = new PointF[]
                {
                    new(tx - tw + 2, cy),
                    new(tx + tw - 2, cy - tw),
                    new(tx + tw - 2, cy + tw),
                };
                g.FillPolygon(wb, pts);
            }
            else
            {
                // Triangle pointing right, bar on right
                var pts = new PointF[]
                {
                    new(tx + tw - 2, cy),
                    new(tx - tw + 2, cy - tw),
                    new(tx - tw + 2, cy + tw),
                };
                g.FillPolygon(wb, pts);
                g.FillRectangle(wb, tx + tw + 1, cy - tw, 3, tw * 2);
            }
        }

        private static string FormatTime(double secs)
        {
            if (secs <= 0) return "0:00";
            var ts = TimeSpan.FromSeconds(secs);
            return ts.TotalHours >= 1
                ? $"{(int)ts.TotalHours}:{ts.Minutes:D2}:{ts.Seconds:D2}"
                : $"{ts.Minutes}:{ts.Seconds:D2}";
        }

        private void UploadTexture()
        {
            if (_bitmap == null || OpenVR.Overlay == null || _overlayHandle == 0) return;

            // 1. Copy GDI+ bitmap (BGRA) → _uploadBuf with R↔B swap for R8G8B8A8_UNorm
            var bmpRect = new Rectangle(0, 0, W, H);
            var bmpData = _bitmap.LockBits(bmpRect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                int bytes = W * H * 4;
                Marshal.Copy(bmpData.Scan0, _uploadBuf, 0, bytes);
                for (int i = 0; i < bytes; i += 4)
                    (_uploadBuf[i], _uploadBuf[i + 2]) = (_uploadBuf[i + 2], _uploadBuf[i]);
            }
            finally { _bitmap.UnlockBits(bmpData); }

            if (_d3dContext != null && _stagingTex != null && _overlayTex != null)
            {
                // 2. Map staging texture (CPU write), copy RGBA pixels row by row
                var mapped = _d3dContext.Map(_stagingTex, 0, MapMode.Write,
                    Vortice.Direct3D11.MapFlags.None);
                try
                {
                    int rowBytes = W * 4;
                    for (int y = 0; y < H; y++)
                        Marshal.Copy(_uploadBuf, y * rowBytes,
                            IntPtr.Add(mapped.DataPointer, (int)(y * mapped.RowPitch)), rowBytes);
                }
                finally { _d3dContext.Unmap(_stagingTex, 0); }

                // 3. GPU-atomic copy: staging → overlay texture.
                //    SteamVR compositor reads overlay texture; CopyResource guarantees it
                //    sees either the old or new content in full — never a partial write.
                _d3dContext.CopyResource(_overlayTex, _stagingTex);

                // 4. SetOverlayTexture with ID3D11Texture2D COM pointer (NOT SRV).
                //    ETextureType.DirectX = D3D11 in the OpenVR API.
                var tex = new Valve.VR.Texture_t
                {
                    handle      = _overlayTex.NativePointer,
                    eType       = ETextureType.DirectX,
                    eColorSpace = EColorSpace.Auto,
                };
                OpenVR.Overlay.SetOverlayTexture(_overlayHandle, ref tex);

                // 5. Flush GPU command queue so compositor gets the completed texture.
                //    Without Flush, SteamVR may composite before CopyResource finishes.
                _d3dContext.Flush();
            }
            else
            {
                // Fallback: SetOverlayRaw (D3D11 unavailable — may flicker)
                var pinned = GCHandle.Alloc(_uploadBuf, GCHandleType.Pinned);
                try { OpenVR.Overlay.SetOverlayRaw(_overlayHandle, pinned.AddrOfPinnedObject(), (uint)W, (uint)H, 4); }
                finally { pinned.Free(); }
            }
        }

        // ── GDI+ helpers ──────────────────────────────────────────────────────

        private static void FillRoundedRect(Graphics g, Brush brush, int x, int y, int w, int h, int r)
        {
            if (w <= 0 || h <= 0) return;
            r = Math.Min(r, Math.Min(w / 2, h / 2));
            using var path = RoundedRectPath(x, y, w, h, r);
            g.FillPath(brush, path);
        }

        private static void DrawRoundedRect(Graphics g, Pen pen, int x, int y, int w, int h, int r)
        {
            if (w <= 0 || h <= 0) return;
            r = Math.Min(r, Math.Min(w / 2, h / 2));
            using var path = RoundedRectPath(x, y, w, h, r);
            g.DrawPath(pen, path);
        }

        private static GraphicsPath RoundedRectPath(int x, int y, int w, int h, int r)
        {
            var path = new GraphicsPath();
            int d = r * 2;
            path.AddArc(x, y, d, d, 180, 90);
            path.AddArc(x + w - d, y, d, d, 270, 90);
            path.AddArc(x + w - d, y + h - d, d, d, 0, 90);
            path.AddArc(x, y + h - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        // ── IDisposable ────────────────────────────────────────────────────────

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            Disconnect();
            _cts?.Dispose();
        }
    }
}
#endif
