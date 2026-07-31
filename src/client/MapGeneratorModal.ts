/**
 * Embedded map generator page for the desktop application.
 *
 * The element keeps its historical tag name because the page is already
 * referenced by the bootstrap HTML, but it is a normal page rather than a
 * modal overlay. That keeps the main navigation and background visible while
 * the generator is in use.
 */

import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "./Utils";

const INPUT_CLASS =
  "w-full rounded-lg border border-white/10 bg-black/35 px-3 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-white/30 focus:border-malibu-blue focus:ring-1 focus:ring-malibu-blue/40";
const MAX_SEED_MAP_DIMENSION = 8000;

type GenerationMode = "image" | "seed";
type SeedMode = "random" | "custom";

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

function createRandomSeed(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function text(key: string, fallback: string): string {
  const translated = translateText(key);
  return translated === key ? fallback : translated;
}

@customElement("map-generator-modal")
export class MapGeneratorModal extends LitElement {
  @state() private generationMode: GenerationMode = "image";
  @state() private seedMode: SeedMode = "random";
  @state() private randomSeed = createRandomSeed();
  @state() private customSeed = "";
  @state() private inputImage: string | null = null;
  @state() private mapName = "";
  @state() private width = "";
  @state() private height = "";
  @state() private waterLevel = "127";
  @state() private mountainThreshold = "200";
  @state() private brightness = "0";
  @state() private contrast = "100";
  @state() private invert = false;
  @state() private removeSmall = true;
  @state() private minIslandSize = "30";
  @state() private minLakeSize = "200";
  @state() private previewDataUrl: string | null = null;
  @state() private previewWidth = 0;
  @state() private previewHeight = 0;
  @state() private previewing = false;
  @state() private generating = false;
  @state() private resultMessage: string | null = null;
  @state() private resultSuccess = false;
  @state() private outputPath: string | null = null;
  @state() private outputFolder: string | null = null;
  @state() private exportingFolder: string | null = null;
  @state() private savedMaps: Array<{
    folder: string;
    name: string;
    width: number;
    height: number;
  }> = [];

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.refreshSavedMaps();
  }

  private isElectron(): boolean {
    return typeof window !== "undefined" && window.electronAPI !== undefined;
  }

  private setGenerationMode(mode: GenerationMode): void {
    this.generationMode = mode;
    this.clearPreview();
    this.resultMessage = null;
    this.outputPath = null;
    if (mode === "seed") {
      if (!this.width) this.width = "512";
      if (!this.height) this.height = "512";
    }
  }

  private setSeedMode(mode: SeedMode): void {
    this.seedMode = mode;
    this.clearPreview();
    this.resultMessage = null;
    this.outputPath = null;
  }

  private randomizeSeed(): void {
    this.randomSeed = createRandomSeed();
    this.clearPreview();
    this.resultMessage = null;
    this.outputPath = null;
  }

  private async handlePickImage(): Promise<void> {
    if (!this.isElectron()) {
      this.showError("Map Generator is only available in the desktop application.");
      return;
    }

    try {
      const filePath = await window.electronAPI!.mapGen.pickImage();
      if (filePath) {
        this.inputImage = filePath;
        const name = filePath
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.(png|jpe?g|webp|gif)$/i, "") ?? "";
        if (!this.mapName) this.mapName = name;
        this.clearPreview();
        this.resultMessage = null;
        this.outputPath = null;
      }
    } catch (err) {
      this.showError(
        `Failed to pick image: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private showError(message: string): void {
    this.resultMessage = message;
    this.resultSuccess = false;
    this.outputPath = null;
  }

  private clearPreview(): void {
    this.previewDataUrl = null;
    this.previewWidth = 0;
    this.previewHeight = 0;
    this.outputPath = null;
    this.outputFolder = null;
  }

  private activeSeed(): string {
    return this.seedMode === "random" ? this.randomSeed : this.customSeed;
  }

  private buildOptions() {
    return {
      ...(this.generationMode === "image"
        ? { inputImage: this.inputImage! }
        : { seed: this.activeSeed() }),
      outputName: this.mapName.trim() || undefined,
      width: this.width ? Number(this.width) : undefined,
      height: this.height ? Number(this.height) : undefined,
      waterLevel: Number(this.waterLevel),
      mountainThreshold: Number(this.mountainThreshold),
      brightness: Number(this.brightness),
      contrast: Number(this.contrast),
      invert: this.invert,
      removeSmall: this.removeSmall,
      minIslandSize: Number(this.minIslandSize),
      minLakeSize: Number(this.minLakeSize),
    };
  }

  private validateInput(requireName: boolean): string | null {
    if (!this.isElectron()) return "Map Generator is only available in the desktop application.";
    if (this.generationMode === "image" && !this.inputImage) {
      return "Select a source image before previewing the map.";
    }
    const seed = this.activeSeed();
    if (this.generationMode === "seed") {
      if (!seed) return "Enter a seed before previewing the map.";
      if (seed.length > 128 || !PRINTABLE_ASCII.test(seed)) {
        return "Seeds may use 1–128 printable ASCII characters only.";
      }
      for (const [label, value] of [["width", this.width], ["height", this.height]] as const) {
        if (!value) continue;
        const dimension = Number(value);
        if (!Number.isInteger(dimension) || dimension < 32 || dimension > MAX_SEED_MAP_DIMENSION) {
          return `${label} must be an integer from 32 to ${MAX_SEED_MAP_DIMENSION} for seed maps.`;
        }
      }
    }
    const water = Number(this.waterLevel);
    const mountain = Number(this.mountainThreshold);
    if (!Number.isInteger(water) || !Number.isInteger(mountain) || water < 0 || water > 255 || mountain < 0 || mountain > 255 || mountain <= water) {
      return "Mountain threshold must be greater than water level, with both values from 0 to 255.";
    }
    const brightness = Number(this.brightness);
    const contrast = Number(this.contrast);
    if (!Number.isInteger(brightness) || brightness < -100 || brightness > 100 || !Number.isInteger(contrast) || contrast < 25 || contrast > 300) {
      return "Brightness must be -100 to 100 and contrast must be 25% to 300%.";
    }
    const minIslandSize = Number(this.minIslandSize);
    const minLakeSize = Number(this.minLakeSize);
    if (!Number.isInteger(minIslandSize) || minIslandSize < 1 || !Number.isInteger(minLakeSize) || minLakeSize < 1) {
      return "Minimum island and lake sizes must be positive whole numbers.";
    }
    if (requireName && !this.mapName.trim()) return "Enter a name for the generated map.";
    return null;
  }

  private async handlePreview(): Promise<void> {
    const validationError = this.validateInput(false);
    if (validationError) {
      this.showError(validationError);
      return;
    }
    this.previewing = true;
    this.resultMessage = "Preparing preview...";
    this.resultSuccess = false;
    try {
      const result = await window.electronAPI!.mapGen.preview(this.buildOptions());
      if (!result.success || !result.dataUrl) {
        this.showError(result.error ?? "Unable to create preview.");
        return;
      }
      this.previewDataUrl = result.dataUrl;
      this.previewWidth = result.width ?? 0;
      this.previewHeight = result.height ?? 0;
      this.resultMessage = "Preview ready. Adjust settings and preview again, or save this map.";
      this.resultSuccess = true;
    } catch (err) {
      this.showError(`Preview failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.previewing = false;
    }
  }

  private async handleGenerate(): Promise<void> {
    const validationError = this.validateInput(true);
    if (validationError) {
      this.showError(validationError);
      return;
    }
    if (!this.previewDataUrl) {
      this.showError("Preview the map before saving it.");
      return;
    }

    this.generating = true;
    this.resultMessage = "Generating map...";
    this.resultSuccess = false;
    this.outputPath = null;

    try {
      const result = await window.electronAPI!.mapGen.generate(this.buildOptions());

      if (result.success) {
        this.resultMessage = `Map "${this.mapName.trim()}" generated successfully.`;
        this.resultSuccess = true;
        this.outputPath = result.outputPath ?? null;
        this.outputFolder = result.outputFolder ?? null;
        await this.refreshSavedMaps();
        window.dispatchEvent(new CustomEvent("custom-maps-updated"));
      } else {
        this.showError(result.error ?? "Unknown error during generation.");
      }
    } catch (err) {
      this.showError(
        `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.generating = false;
    }
  }

  private async refreshSavedMaps(): Promise<void> {
    if (!this.isElectron()) return;
    try {
      this.savedMaps = (await window.electronAPI!.mapGen.list()).maps;
    } catch (error) {
      console.warn("Failed to list generated maps", error);
    }
  }

  private async handleExport(folder: string): Promise<void> {
    if (!this.isElectron()) return;
    this.exportingFolder = folder;
    try {
      const result = await window.electronAPI!.mapGen.exportMap(folder);
      if (result.success) {
        this.resultMessage = `Map exported to ${result.outputPath}.`;
        this.resultSuccess = true;
      } else if (result.error !== "Export cancelled.") {
        this.showError(result.error ?? "Unable to export map.");
      }
    } catch (err) {
      this.showError(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.exportingFolder = null;
    }
  }

  private resetForm(): void {
    this.generationMode = "image";
    this.seedMode = "random";
    this.randomSeed = createRandomSeed();
    this.customSeed = "";
    this.inputImage = null;
    this.mapName = "";
    this.width = "";
    this.height = "";
    this.waterLevel = "127";
    this.mountainThreshold = "200";
    this.brightness = "0";
    this.contrast = "100";
    this.invert = false;
    this.removeSmall = true;
    this.minIslandSize = "30";
    this.minLakeSize = "200";
    this.clearPreview();
    this.resultMessage = null;
    this.resultSuccess = false;
    this.outputPath = null;
    this.outputFolder = null;
  }

  private goBack(): void {
    window.showPage?.("page-play");
  }

  render() {
    const selectedFile = this.inputImage?.split(/[\\/]/).pop();
    const activeSeed = this.seedMode === "random" ? this.randomSeed : this.customSeed;

    return html`
      <div class="flex min-h-full w-full flex-col gap-6 px-2 pb-8 lg:px-4">
        <header class="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-5">
          <div class="flex items-start gap-3">
            <div class="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-malibu-blue/40 bg-malibu-blue/15 text-malibu-blue shadow-[var(--shadow-malibu-blue-soft)]">
              <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="m7 15 3-3 2 2 3-4 2 2" />
              </svg>
            </div>
            <div>
              <div class="mb-1 flex flex-wrap items-center gap-2">
                <span class="text-[10px] font-bold uppercase tracking-[0.22em] text-malibu-blue">Desktop tool</span>
                <span class="h-1 w-1 rounded-full bg-white/30"></span>
                <span class="text-[10px] uppercase tracking-[0.18em] text-white/40">World builder</span>
              </div>
              <h1 class="text-2xl font-bold uppercase tracking-[0.12em] text-white lg:text-3xl">
                ${text("map_generator.title", "Map Generator")}
              </h1>
              <p class="mt-2 max-w-2xl text-sm leading-6 text-white/55">
                Create a playable OpenFront map from a height-map image or a deterministic seed. Tune the terrain settings and generate it locally.
              </p>
            </div>
          </div>
          <button
            class="nav-menu-item inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold uppercase tracking-wider text-white/60 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white"
            data-page="page-play"
            @click=${this.goBack}
          >
            <span aria-hidden="true">←</span>
            Back to play
          </button>
        </header>

        ${!this.isElectron()
          ? html`
              <div class="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-200">
                <span class="mt-0.5 text-amber-300" aria-hidden="true">!</span>
                <p>This tool is available in the OpenFront Desktop application.</p>
              </div>
            `
          : ""}

        <section class="rounded-2xl border border-white/10 bg-surface/90 p-4 shadow-[var(--shadow-malibu-blue-soft)] lg:p-5">
          <div class="mb-4">
            <h2 class="text-sm font-bold uppercase tracking-[0.16em] text-white">Generation source</h2>
            <p class="mt-1 text-xs text-white/45">Choose an image for full control, or use a seed to create a repeatable procedural map.</p>
          </div>
          <div class="grid gap-2 sm:grid-cols-2">
            <button
              class="flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${this.generationMode === "image" ? "border-malibu-blue/60 bg-malibu-blue/15 text-white shadow-[var(--shadow-malibu-blue-soft)]" : "border-white/10 bg-white/5 text-white/55 hover:border-white/20 hover:bg-white/10"}"
              @click=${() => this.setGenerationMode("image")}
            >
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/20 text-malibu-blue" aria-hidden="true">▧</span>
              <span><span class="block text-sm font-semibold">Source image</span><span class="mt-0.5 block text-xs text-white/40">Import and convert a regular image</span></span>
            </button>
            <button
              class="flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${this.generationMode === "seed" ? "border-malibu-blue/60 bg-malibu-blue/15 text-white shadow-[var(--shadow-malibu-blue-soft)]" : "border-white/10 bg-white/5 text-white/55 hover:border-white/20 hover:bg-white/10"}"
              @click=${() => this.setGenerationMode("seed")}
            >
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/20 text-malibu-blue" aria-hidden="true">#</span>
              <span><span class="block text-sm font-semibold">Seed</span><span class="mt-0.5 block text-xs text-white/40">Generate a repeatable map</span></span>
            </button>
          </div>
        </section>

        <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_260px]">
          <div class="flex min-w-0 flex-col gap-5">
            ${this.generationMode === "image"
              ? html`
            <section class="rounded-2xl border border-white/10 bg-surface/90 p-4 shadow-[var(--shadow-malibu-blue-soft)] lg:p-6">
              <div class="mb-5 flex items-start justify-between gap-3">
                <div>
                  <h2 class="text-sm font-bold uppercase tracking-[0.16em] text-white">Source image</h2>
                  <p class="mt-1 text-xs text-white/45">Use an ordinary image; OpenFront converts its luminance into terrain elevation.</p>
                </div>
                <span class="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-wider text-white/45">PNG · JPG · WEBP</span>
              </div>
              <button
                class="group flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-malibu-blue/40 bg-malibu-blue/5 px-4 py-7 text-center transition-colors hover:border-malibu-blue hover:bg-malibu-blue/10 disabled:cursor-not-allowed disabled:opacity-50"
                @click=${this.handlePickImage}
                ?disabled=${!this.isElectron() || this.generating}
              >
                <span class="flex h-11 w-11 items-center justify-center rounded-full border border-malibu-blue/40 bg-malibu-blue/15 text-malibu-blue transition-transform group-hover:scale-105" aria-hidden="true">
                  <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.7">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 16V4m0 0L8 8m4-4 4 4M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13" />
                  </svg>
                </span>
                <span class="text-sm font-semibold text-white">${text("map_generator.browse", "Choose source image")}</span>
                <span class="max-w-full truncate text-xs text-white/45">${selectedFile ?? "No image selected"}</span>
              </button>
              ${this.inputImage
                ? html`<p class="mt-3 truncate text-xs text-white/35" title=${this.inputImage}>${this.inputImage}</p>`
                : ""}
            </section>
              `
              : html`
            <section class="rounded-2xl border border-white/10 bg-surface/90 p-4 shadow-[var(--shadow-malibu-blue-soft)] lg:p-6">
              <div class="mb-5 flex items-start justify-between gap-3">
                <div>
                  <h2 class="text-sm font-bold uppercase tracking-[0.16em] text-white">Seed settings</h2>
                  <p class="mt-1 text-xs text-white/45">Random seeds are shown so you can save and reproduce a map later.</p>
                </div>
                <span class="rounded-full border border-malibu-blue/30 bg-malibu-blue/10 px-2 py-1 text-[10px] uppercase tracking-wider text-malibu-blue">Deterministic</span>
              </div>
              <div class="mb-4 grid grid-cols-2 gap-2">
                <button
                  class="rounded-lg border px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors ${this.seedMode === "random" ? "border-malibu-blue/60 bg-malibu-blue/15 text-white" : "border-white/10 bg-white/5 text-white/50 hover:bg-white/10 hover:text-white"}"
                  @click=${() => this.setSeedMode("random")}
                >Random seed</button>
                <button
                  class="rounded-lg border px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors ${this.seedMode === "custom" ? "border-malibu-blue/60 bg-malibu-blue/15 text-white" : "border-white/10 bg-white/5 text-white/50 hover:bg-white/10 hover:text-white"}"
                  @click=${() => this.setSeedMode("custom")}
                >Custom seed</button>
              </div>
              ${this.seedMode === "random"
                ? html`
                    <div class="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
                      <code class="min-w-0 flex-1 break-all text-sm text-malibu-blue">${this.randomSeed}</code>
                      <button
                        class="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white/65 transition-colors hover:bg-white/10 hover:text-white"
                        @click=${this.randomizeSeed}
                      >New seed</button>
                    </div>
                  `
                : html`
                    <input
                      type="text"
                      maxlength="128"
                      .value=${this.customSeed}
                      @input=${(e: InputEvent) => { this.customSeed = (e.target as HTMLInputElement).value; this.clearPreview(); }}
                      placeholder="coastline! 42 / alpha"
                      class=${INPUT_CLASS}
                      aria-label="Custom seed"
                    />
                    <p class="mt-2 text-[11px] text-white/35">Use 1–128 printable ASCII characters, including spaces and punctuation.</p>
                  `}
              <div class="mt-4 rounded-lg border border-malibu-blue/20 bg-malibu-blue/5 p-3 text-xs leading-5 text-white/50">
                Active seed: <code class="break-all text-malibu-blue">${activeSeed || "—"}</code>
              </div>
            </section>
              `}

            <section class="rounded-2xl border border-white/10 bg-surface/90 p-4 shadow-[var(--shadow-malibu-blue-soft)] lg:p-6">
              <div class="mb-5">
                <h2 class="text-sm font-bold uppercase tracking-[0.16em] text-white">Map settings</h2>
                <p class="mt-1 text-xs text-white/45">${this.generationMode === "seed" ? "Seed maps default to 512 × 512 when dimensions are blank." : "Dimensions are detected from the source image when left blank."}</p>
              </div>
              <div class="grid gap-4 sm:grid-cols-2">
                <label class="sm:col-span-2">
                  <span class="mb-2 block text-xs font-bold uppercase tracking-wider text-white/65">${text("map_generator.map_name", "Map name")}</span>
                  <input
                    type="text"
                    .value=${this.mapName}
                    @input=${(e: InputEvent) => (this.mapName = (e.target as HTMLInputElement).value)}
                    placeholder="My Custom Map"
                    class=${INPUT_CLASS}
                  />
                </label>
                <label>
                  <span class="mb-2 block text-xs font-bold uppercase tracking-wider text-white/65">${text("map_generator.width", "Width")}</span>
                  <input
                    type="number"
                    min="1"
                    max=${MAX_SEED_MAP_DIMENSION}
                    .value=${this.width}
                    @input=${(e: InputEvent) => { this.width = (e.target as HTMLInputElement).value; this.clearPreview(); }}
                    placeholder="Auto-detect"
                    class=${INPUT_CLASS}
                  />
                  <span class="mt-1 block text-[11px] text-white/35">Pixels</span>
                </label>
                <label>
                  <span class="mb-2 block text-xs font-bold uppercase tracking-wider text-white/65">${text("map_generator.height", "Height")}</span>
                  <input
                    type="number"
                    min="1"
                    max=${MAX_SEED_MAP_DIMENSION}
                    .value=${this.height}
                    @input=${(e: InputEvent) => { this.height = (e.target as HTMLInputElement).value; this.clearPreview(); }}
                    placeholder="Auto-detect"
                    class=${INPUT_CLASS}
                  />
                  <span class="mt-1 block text-[11px] text-white/35">Pixels</span>
                </label>
              </div>
            </section>

            <section class="rounded-2xl border border-white/10 bg-surface/90 p-4 shadow-[var(--shadow-malibu-blue-soft)] lg:p-6">
              <div class="mb-5">
                <h2 class="text-sm font-bold uppercase tracking-[0.16em] text-white">Terrain thresholds</h2>
                <p class="mt-1 text-xs text-white/45">These values control how the blue channel is classified.</p>
              </div>
              <div class="grid gap-4 sm:grid-cols-2">
                <label>
                  <span class="mb-2 block text-xs font-bold uppercase tracking-wider text-white/65">${text("map_generator.water_level", "Water level (0–255)")}</span>
                  <input
                    type="number"
                    min="0"
                    max="255"
                    .value=${this.waterLevel}
                    @input=${(e: InputEvent) => { this.waterLevel = (e.target as HTMLInputElement).value; this.clearPreview(); }}
                    class=${INPUT_CLASS}
                  />
                  <span class="mt-1 block text-[11px] text-white/35">Blue values below this become water.</span>
                </label>
                <label>
                  <span class="mb-2 block text-xs font-bold uppercase tracking-wider text-white/65">${text("map_generator.mountain_threshold", "Mountain threshold (0–255)")}</span>
                  <input
                    type="number"
                    min="0"
                    max="255"
                    .value=${this.mountainThreshold}
                    @input=${(e: InputEvent) => { this.mountainThreshold = (e.target as HTMLInputElement).value; this.clearPreview(); }}
                    class=${INPUT_CLASS}
                  />
                  <span class="mt-1 block text-[11px] text-white/35">Blue values above this become mountains.</span>
                </label>
              </div>
            </section>

            ${this.generationMode === "image"
              ? html`<section class="rounded-2xl border border-white/10 bg-surface/90 p-4 shadow-[var(--shadow-malibu-blue-soft)] lg:p-6">
                  <div class="mb-5">
                    <h2 class="text-sm font-bold uppercase tracking-[0.16em] text-white">Image conversion</h2>
                    <p class="mt-1 text-xs text-white/45">Tune how a normal photograph or image becomes elevation before it is saved.</p>
                  </div>
                  <div class="grid gap-4 sm:grid-cols-2">
                    <label>
                      <span class="mb-2 block text-xs font-bold uppercase tracking-wider text-white/65">Brightness</span>
                      <input type="number" min="-100" max="100" .value=${this.brightness} @input=${(e: InputEvent) => { this.brightness = (e.target as HTMLInputElement).value; this.clearPreview(); }} class=${INPUT_CLASS} />
                      <span class="mt-1 block text-[11px] text-white/35">-100 darkens, +100 brightens.</span>
                    </label>
                    <label>
                      <span class="mb-2 block text-xs font-bold uppercase tracking-wider text-white/65">Contrast (%)</span>
                      <input type="number" min="25" max="300" .value=${this.contrast} @input=${(e: InputEvent) => { this.contrast = (e.target as HTMLInputElement).value; this.clearPreview(); }} class=${INPUT_CLASS} />
                      <span class="mt-1 block text-[11px] text-white/35">100% keeps the source contrast.</span>
                    </label>
                    <label class="sm:col-span-2 flex items-center gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
                      <input type="checkbox" .checked=${this.invert} @change=${(e: Event) => { this.invert = (e.target as HTMLInputElement).checked; this.clearPreview(); }} class="h-4 w-4 accent-malibu-blue" />
                      <span><span class="block text-sm font-semibold text-white">Invert elevation</span><span class="block text-xs text-white/40">Bright areas become low terrain and dark areas become high terrain.</span></span>
                    </label>
                  </div>
                </section>`
              : null}

            <section class="rounded-2xl border border-white/10 bg-surface/90 p-4 shadow-[var(--shadow-malibu-blue-soft)] lg:p-6">
              <div class="mb-5">
                <h2 class="text-sm font-bold uppercase tracking-[0.16em] text-white">Terrain cleanup</h2>
                <p class="mt-1 text-xs text-white/45">Recommended cleanup removes tiny islands and lakes that are difficult to play on.</p>
              </div>
              <div class="grid gap-4 sm:grid-cols-2">
                <label class="sm:col-span-2 flex items-center gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
                  <input type="checkbox" .checked=${this.removeSmall} @change=${(e: Event) => { this.removeSmall = (e.target as HTMLInputElement).checked; this.clearPreview(); }} class="h-4 w-4 accent-malibu-blue" />
                  <span><span class="block text-sm font-semibold text-white">Remove small land and water bodies</span><span class="block text-xs text-white/40">Keeps the generated map cleaner and easier to navigate.</span></span>
                </label>
                <label>
                  <span class="mb-2 block text-xs font-bold uppercase tracking-wider text-white/65">Minimum island size</span>
                  <input type="number" min="1" max="100000" .value=${this.minIslandSize} @input=${(e: InputEvent) => { this.minIslandSize = (e.target as HTMLInputElement).value; this.clearPreview(); }} class=${INPUT_CLASS} />
                  <span class="mt-1 block text-[11px] text-white/35">Tiles; default 30.</span>
                </label>
                <label>
                  <span class="mb-2 block text-xs font-bold uppercase tracking-wider text-white/65">Minimum lake size</span>
                  <input type="number" min="1" max="100000" .value=${this.minLakeSize} @input=${(e: InputEvent) => { this.minLakeSize = (e.target as HTMLInputElement).value; this.clearPreview(); }} class=${INPUT_CLASS} />
                  <span class="mt-1 block text-[11px] text-white/35">Tiles; default 200.</span>
                </label>
              </div>
            </section>

            <section class="rounded-2xl border border-malibu-blue/30 bg-malibu-blue/5 p-4 shadow-[var(--shadow-malibu-blue-soft)] lg:p-6">
              <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 class="text-sm font-bold uppercase tracking-[0.16em] text-white">Preview</h2>
                  <p class="mt-1 text-xs text-white/45">Preview the converted terrain before writing any map files.</p>
                </div>
                ${this.previewWidth > 0 ? html`<span class="rounded-full border border-malibu-blue/30 bg-malibu-blue/10 px-2 py-1 text-[10px] uppercase tracking-wider text-malibu-blue">${this.previewWidth} × ${this.previewHeight}</span>` : null}
              </div>
              ${this.previewDataUrl
                ? html`<div class="overflow-hidden rounded-xl border border-white/10 bg-black/30"><img src=${this.previewDataUrl} alt="Generated terrain preview" class="max-h-[520px] w-full object-contain" /></div>`
                : html`<div class="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/20 px-5 text-center text-sm text-white/40">Choose your source and settings, then click Preview map.</div>`}
              <button class="mt-4 w-full rounded-lg border border-malibu-blue/40 bg-malibu-blue/15 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-malibu-blue/25 disabled:cursor-not-allowed disabled:opacity-40" @click=${this.handlePreview} ?disabled=${this.previewing || this.generating || !this.isElectron()}>
                ${this.previewing ? "Preparing preview…" : this.previewDataUrl ? "Update preview" : "Preview map"}
              </button>
            </section>
          </div>

          <aside class="flex flex-col gap-5">
            ${this.savedMaps.length > 0
              ? html`<section class="rounded-2xl border border-white/10 bg-surface/70 p-5">
                  <div class="mb-4 flex items-center justify-between gap-3">
                    <h2 class="text-xs font-bold uppercase tracking-[0.16em] text-white">Saved maps</h2>
                    <button class="text-[10px] font-bold uppercase tracking-wider text-white/40 hover:text-white" @click=${this.refreshSavedMaps}>Refresh</button>
                  </div>
                  <div class="space-y-2">
                    ${this.savedMaps.map((map) => html`<div class="flex items-center gap-3 rounded-lg border border-white/10 bg-black/20 p-2.5">
                      <div class="min-w-0 flex-1"><div class="truncate text-xs font-semibold text-white" title=${map.name}>${map.name}</div><div class="text-[10px] text-white/35">${map.width} × ${map.height}</div></div>
                      <button class="shrink-0 rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-40" @click=${() => this.handleExport(map.folder)} ?disabled=${this.exportingFolder !== null}>${this.exportingFolder === map.folder ? "…" : "Export"}</button>
                    </div>`)}
                  </div>
                </section>`
              : null}
            <section class="rounded-2xl border border-white/10 bg-surface/70 p-5">
              <div class="mb-4 flex items-center gap-2">
                <span class="h-2 w-2 rounded-full bg-malibu-blue shadow-[0_0_10px_rgba(0,132,209,0.8)]"></span>
                <h2 class="text-xs font-bold uppercase tracking-[0.16em] text-white">How it works</h2>
              </div>
              <ol class="space-y-4 text-xs leading-5 text-white/50">
                <li class="flex gap-3"><span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-malibu-blue/20 text-[10px] font-bold text-malibu-blue">1</span><span>Choose a source image or switch to a seed.</span></li>
                <li class="flex gap-3"><span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-malibu-blue/20 text-[10px] font-bold text-malibu-blue">2</span><span>Adjust conversion and terrain settings.</span></li>
                <li class="flex gap-3"><span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-malibu-blue/20 text-[10px] font-bold text-malibu-blue">3</span><span>Preview and regenerate until the terrain looks right.</span></li>
                <li class="flex gap-3"><span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-malibu-blue/20 text-[10px] font-bold text-malibu-blue">4</span><span>Save the map locally or export it as a shareable ZIP.</span></li>
              </ol>
            </section>
            <section class="rounded-2xl border border-white/10 bg-black/20 p-5">
              <h2 class="text-xs font-bold uppercase tracking-[0.16em] text-white">Terrain guide</h2>
              <div class="mt-4 space-y-3 text-xs text-white/45">
                <div class="flex items-center gap-3"><span class="h-3 w-3 rounded-full bg-sky-500"></span><span>Lower blue values → water</span></div>
                <div class="flex items-center gap-3"><span class="h-3 w-3 rounded-full bg-emerald-500"></span><span>Middle values → land</span></div>
                <div class="flex items-center gap-3"><span class="h-3 w-3 rounded-full bg-slate-200"></span><span>Higher values → mountains</span></div>
              </div>
            </section>
          </aside>
        </div>

        ${this.resultMessage
          ? html`
              <div class="rounded-xl border p-4 text-sm ${this.resultSuccess ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200" : "border-red-400/30 bg-red-500/10 text-red-200"}">
                <div class="font-medium">${this.resultMessage}</div>
                ${this.outputPath ? html`<div class="mt-2 break-all text-xs text-white/45">Output: ${this.outputPath}</div>` : ""}
                ${this.resultSuccess && this.outputFolder
                  ? html`<button class="mt-3 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-40" @click=${() => this.handleExport(this.outputFolder!)} ?disabled=${this.exportingFolder !== null}>${this.exportingFolder ? "Exporting…" : "Export map"}</button>`
                  : null}
              </div>
            `
          : ""}

        <footer class="flex flex-wrap items-center justify-end gap-3 border-t border-white/10 pt-5">
          <button
            class="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            @click=${this.resetForm}
            ?disabled=${this.generating}
          >
            Reset
          </button>
          <button
            class="rounded-lg border border-malibu-blue/40 bg-malibu-blue/10 px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-white shadow-[0_0_14px_rgba(0,132,209,0.18)] transition-all hover:bg-malibu-blue/20 disabled:cursor-not-allowed disabled:opacity-40"
            @click=${this.handlePreview}
            ?disabled=${this.previewing || this.generating || !this.isElectron()}
          >
            ${this.previewing ? "Previewing…" : "Preview map"}
          </button>
          <button
            class="rounded-lg bg-frame-orange px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-white shadow-[0_0_14px_rgba(249,115,22,0.25)] transition-all hover:brightness-110 hover:shadow-[0_0_18px_rgba(249,115,22,0.4)] disabled:cursor-not-allowed disabled:opacity-40"
            @click=${this.handleGenerate}
            ?disabled=${this.generating || this.previewing || !this.previewDataUrl || !this.isElectron()}
          >
            ${this.generating ? text("map_generator.generating", "Generating…") : text("map_generator.generate", "Generate map")}
          </button>
        </footer>
      </div>
    `;
  }
}
