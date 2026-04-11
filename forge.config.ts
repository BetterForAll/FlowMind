import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { VitePlugin } from "@electron-forge/plugin-vite";
import path from "node:path";
import fs from "node:fs";

function copyNativeModules(buildPath: string) {
  const externals = ["uiohook-napi", "dotenv", "node-gyp-build"];
  const srcNodeModules = path.resolve(__dirname, "node_modules");
  const destNodeModules = path.join(buildPath, "node_modules");

  for (const mod of externals) {
    const src = path.join(srcNodeModules, mod);
    const dest = path.join(destNodeModules, mod);
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, { recursive: true });
    }
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: false,
    name: "FlowMind",
  },
  rebuildConfig: {
    onlyModules: [], // Skip native rebuild — uiohook-napi ships prebuilt binaries
  },
  hooks: {
    postPackage: async (_config, options) => {
      // Copy externalized native modules into the packaged app
      const appPath = path.join(options.outputPaths[0], "resources", "app");
      if (fs.existsSync(appPath)) {
        copyNativeModules(appPath);
      } else {
        // asar: false — files are directly in resources/app or the output root
        copyNativeModules(options.outputPaths[0]);
      }
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ["darwin"]),
    new MakerDeb({}),
    new MakerRpm({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
  ],
};

export default config;
