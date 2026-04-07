import type { FlowMindAPI } from "../preload";

declare global {
  interface Window {
    flowmind: FlowMindAPI;
  }
}
