import { useState, useEffect } from "react";

type FlowMode = "economy" | "standard" | "pro" | "maximum";

interface Settings {
  mode: FlowMode;
  cleanupMode: string;
  detectionIntervalMinutes: number;
  screenshotIntervalMs: number;
  thinking: boolean;
  showRawData: boolean;
  transcriptionModel: string | null;
  detectionModel: string | null;
  automationModel: string | null;
  screenshotResolution: { width: number; height: number } | null;
  screenshotQuality: number | null;
  geminiApiKey: string | null;
}

const MODE_INFO: Record<FlowMode, { label: string; desc: string; cost: string }> = {
  economy: {
    label: "Economy",
    desc: "Gemini Flash Lite for all tasks. Lowest cost, basic quality.",
    cost: "~$8/month",
  },
  standard: {
    label: "Standard",
    desc: "Gemini Flash for all tasks. Good balance of cost and quality.",
    cost: "~$25/month",
  },
  pro: {
    label: "Pro",
    desc: "Gemini Pro for detection & automation. Higher accuracy.",
    cost: "~$80/month",
  },
  maximum: {
    label: "Maximum",
    desc: "Gemini Pro with extended thinking. Deepest analysis.",
    cost: "~$120/month",
  },
};

const GEMINI_MODELS = [
  { value: "", label: "Use mode default" },
  { value: "gemini-2.5-flash-lite", label: "Flash Lite (cheapest)" },
  { value: "gemini-2.5-flash", label: "Flash (balanced)" },
  { value: "gemini-2.5-pro", label: "Pro (best quality)" },
];

const RESOLUTION_OPTIONS = [
  { value: "", label: "Use mode default" },
  { value: "960x540", label: "960×540 (smaller files)" },
  { value: "1280x720", label: "1280×720 (more detail)" },
  { value: "1920x1080", label: "1920×1080 (full HD)" },
];

const CLEANUP_OPTIONS = [
  { value: "after-analysis", label: "Delete after each analysis" },
  { value: "1h", label: "Keep for 1 hour" },
  { value: "4h", label: "Keep for 4 hours" },
  { value: "manual", label: "Manual cleanup only" },
];

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    window.flowmind.getSettings().then((s) => setSettings(s as Settings));
  }, []);

  const update = async (key: string, value: unknown) => {
    const updated = { ...settings!, [key]: value };
    setSettings(updated);
    await window.flowmind.updateSettings({ [key]: value });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!settings) return <div className="empty-state"><p>Loading...</p></div>;

  const resolutionValue = settings.screenshotResolution
    ? `${settings.screenshotResolution.width}x${settings.screenshotResolution.height}`
    : "";

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        {saved && <span style={{ color: "var(--green)", fontSize: 13 }}>Saved</span>}
      </div>

      {/* AI Mode */}
      <div className="settings-section">
        <h2 className="settings-heading">AI Mode</h2>
        <p className="settings-desc">
          Choose the quality level for AI analysis. Higher modes use better models but cost more.
        </p>
        <div className="mode-cards">
          {(Object.entries(MODE_INFO) as [FlowMode, typeof MODE_INFO.economy][]).map(([mode, info]) => (
            <label
              key={mode}
              className={`mode-card ${settings.mode === mode ? "mode-card-active" : ""}`}
            >
              <input
                type="radio"
                name="mode"
                value={mode}
                checked={settings.mode === mode}
                onChange={() => {
                  update("mode", mode);
                  // Reset thinking based on mode default
                  if (mode === "maximum") update("thinking", true);
                  else update("thinking", false);
                }}
                style={{ display: "none" }}
              />
              <div className="mode-card-title">{info.label}</div>
              <div className="mode-card-desc">{info.desc}</div>
              <div className="mode-card-cost">{info.cost}</div>
            </label>
          ))}
        </div>
      </div>

      {/* Thinking Mode */}
      <div className="settings-section">
        <h2 className="settings-heading">Extended Thinking</h2>
        <p className="settings-desc">
          When enabled, the AI reasons step-by-step before producing results.
          Deeper analysis but slower and more expensive.
        </p>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.thinking}
            onChange={(e) => update("thinking", e.target.checked)}
          />
          <span>Enable extended thinking</span>
        </label>
      </div>

      {/* Model Overrides */}
      <div className="settings-section">
        <h2 className="settings-heading">Model Overrides</h2>
        <p className="settings-desc">
          Override the default model for each task. Leave as "Use mode default" to use the preset.
        </p>
        <div className="settings-grid">
          <label className="settings-label">
            Transcription
            <select
              className="settings-select"
              value={settings.transcriptionModel ?? ""}
              onChange={(e) => update("transcriptionModel", e.target.value || null)}
            >
              {GEMINI_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="settings-label">
            Detection
            <select
              className="settings-select"
              value={settings.detectionModel ?? ""}
              onChange={(e) => update("detectionModel", e.target.value || null)}
            >
              {GEMINI_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="settings-label">
            Automation
            <select
              className="settings-select"
              value={settings.automationModel ?? ""}
              onChange={(e) => update("automationModel", e.target.value || null)}
            >
              {GEMINI_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Analysis Frequency */}
      <div className="settings-section">
        <h2 className="settings-heading">Analysis Frequency</h2>
        <p className="settings-desc">
          How often FlowMind analyzes captured data to detect workflows.
        </p>
        <select
          className="settings-select"
          value={settings.detectionIntervalMinutes}
          onChange={(e) => update("detectionIntervalMinutes", parseInt(e.target.value))}
        >
          <option value={5}>Every 5 minutes</option>
          <option value={10}>Every 10 minutes</option>
          <option value={15}>Every 15 minutes</option>
          <option value={30}>Every 30 minutes</option>
          <option value={60}>Every 60 minutes</option>
        </select>
      </div>

      {/* Screenshot Settings */}
      <div className="settings-section">
        <h2 className="settings-heading">Screenshot Capture</h2>
        <div className="settings-grid">
          <label className="settings-label">
            Capture interval
            <select
              className="settings-select"
              value={settings.screenshotIntervalMs}
              onChange={(e) => update("screenshotIntervalMs", parseInt(e.target.value))}
            >
              <option value={1000}>Every 1 second</option>
              <option value={2000}>Every 2 seconds</option>
              <option value={5000}>Every 5 seconds</option>
              <option value={10000}>Every 10 seconds</option>
            </select>
          </label>
          <label className="settings-label">
            Resolution
            <select
              className="settings-select"
              value={resolutionValue}
              onChange={(e) => {
                if (!e.target.value) {
                  update("screenshotResolution", null);
                } else {
                  const [w, h] = e.target.value.split("x").map(Number);
                  update("screenshotResolution", { width: w, height: h });
                }
              }}
            >
              {RESOLUTION_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>
          <label className="settings-label">
            JPEG quality
            <select
              className="settings-select"
              value={settings.screenshotQuality ?? ""}
              onChange={(e) => update("screenshotQuality", e.target.value ? parseInt(e.target.value) : null)}
            >
              <option value="">Use mode default</option>
              <option value={50}>50% (smallest files)</option>
              <option value={60}>60%</option>
              <option value={70}>70%</option>
              <option value={80}>80%</option>
              <option value={90}>90% (best quality)</option>
            </select>
          </label>
        </div>
      </div>

      {/* Data Cleanup */}
      <div className="settings-section">
        <h2 className="settings-heading">Data Cleanup</h2>
        <p className="settings-desc">
          How long to keep raw capture data (screenshots, events, audio) after analysis.
        </p>
        <div className="settings-options">
          {CLEANUP_OPTIONS.map((opt) => (
            <label key={opt.value} className="settings-radio">
              <input
                type="radio"
                name="cleanupMode"
                value={opt.value}
                checked={settings.cleanupMode === opt.value}
                onChange={() => update("cleanupMode", opt.value)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* API Key */}
      <div className="settings-section">
        <h2 className="settings-heading">Gemini API Key</h2>
        <p className="settings-desc">
          Optional. If not set, uses the GEMINI_API_KEY from your .env file.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type={showApiKey ? "text" : "password"}
            className="settings-input"
            placeholder="Enter Gemini API key..."
            value={settings.geminiApiKey ?? ""}
            onChange={(e) => update("geminiApiKey", e.target.value || null)}
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-secondary"
            onClick={() => setShowApiKey(!showApiKey)}
            style={{ whiteSpace: "nowrap" }}
          >
            {showApiKey ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {/* Developer Options */}
      <div className="settings-section">
        <h2 className="settings-heading">Developer</h2>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.showRawData}
            onChange={(e) => update("showRawData", e.target.checked)}
          />
          <span>Show Raw Data tab</span>
        </label>
      </div>
    </>
  );
}
