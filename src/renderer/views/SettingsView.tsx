import { useState, useEffect } from "react";

interface Settings {
  cleanupMode: string;
  detectionIntervalMinutes: number;
  audioAutoDetect: boolean;
}

const CLEANUP_OPTIONS = [
  { value: "immediate", label: "Delete immediately after analysis" },
  { value: "1h", label: "Keep for 1 hour" },
  { value: "12h", label: "Keep for 12 hours" },
  { value: "24h", label: "Keep for 24 hours" },
  { value: "7d", label: "Keep for 7 days" },
];

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);

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

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        {saved && <span style={{ color: "var(--green)", fontSize: 13 }}>Saved</span>}
      </div>

      <div className="settings-section">
        <h2 className="settings-heading">Data Cleanup</h2>
        <p className="settings-desc">
          Raw capture data (screenshots, events, audio) is cleaned up after detection
          analyzes it. Choose how long to keep the raw data after analysis.
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

      <div className="settings-section">
        <h2 className="settings-heading">Audio Recording</h2>
        <p className="settings-desc">
          When enabled, audio recording starts automatically whenever any app is
          using your microphone (calls, meetings, voice notes, dictation). Recording
          stops 15 seconds after the microphone goes inactive.
        </p>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.audioAutoDetect}
            onChange={(e) => update("audioAutoDetect", e.target.checked)}
          />
          <span>Auto-record when microphone is in use</span>
        </label>
      </div>

      <div className="settings-section">
        <h2 className="settings-heading">Detection Interval</h2>
        <p className="settings-desc">
          How often FlowMind automatically analyzes captured data to detect flows.
        </p>
        <select
          className="settings-select"
          value={settings.detectionIntervalMinutes}
          onChange={(e) => update("detectionIntervalMinutes", parseInt(e.target.value))}
        >
          <option value={30}>Every 30 minutes</option>
          <option value={60}>Every 60 minutes</option>
          <option value={120}>Every 2 hours</option>
        </select>
      </div>
    </>
  );
}
