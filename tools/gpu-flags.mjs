/**
 * How the test tools' headless Chromium draws: one setting for every tool.
 *
 *   GEMFALL_GPU=vulkan       the real graphics card through Vulkan, so the game runs on WebGL,
 *                            as on a phone. Default when the machine has one (/dev/dri).
 *   GEMFALL_GPU=swiftshader  WebGL in software: slow, but WebGL where there is no card.
 *   GEMFALL_GPU=off          no GPU; Phaser falls back to its Canvas renderer. Default with no
 *                            card (cloud containers).
 *
 * tools/selftest.sh repeats this choice in shell; keep the two in step.
 */
import { existsSync } from 'node:fs';

const FLAGS = {
  vulkan: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan'],
  swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  off: ['--disable-gpu'],
};

export const GPU_MODE = process.env.GEMFALL_GPU || (existsSync('/dev/dri') ? 'vulkan' : 'off');

if (!FLAGS[GPU_MODE]) {
  throw new Error(`GEMFALL_GPU=${GPU_MODE}: use vulkan, swiftshader or off`);
}

/** Chromium flags for the chosen mode. */
export const gpuFlags = () => [...FLAGS[GPU_MODE]];
