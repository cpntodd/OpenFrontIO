import { GameMapType } from "./Game";
import { customMapAssetUrl, isCustomMap } from "./CustomMap";
import { GameMapLoader, MapData } from "./GameMapLoader";

export class FetchGameMapLoader implements GameMapLoader {
  private maps: Map<GameMapType, MapData>;

  public constructor(
    private readonly pathResolver: string | ((path: string) => string),
  ) {
    this.maps = new Map<GameMapType, MapData>();
  }

  public getMapData(map: GameMapType): MapData {
    const cachedMap = this.maps.get(map);
    if (cachedMap) {
      return cachedMap;
    }

    const key = Object.keys(GameMapType).find(
      (k) => GameMapType[k as keyof typeof GameMapType] === map,
    );
    const fileName = key?.toLowerCase();

    if (!fileName && !isCustomMap(map)) {
      throw new Error(`Unknown map: ${map}`);
    }

    const mapUrl = (file: string) =>
      isCustomMap(map)
        ? customMapAssetUrl(map, file)
        : this.url(fileName!, file);

    const mapData = {
      mapBin: () => this.loadBinaryFromUrl(mapUrl("map.bin")),
      map4xBin: () => this.loadBinaryFromUrl(mapUrl("map4x.bin")),
      map16xBin: () => this.loadBinaryFromUrl(mapUrl("map16x.bin")),
      manifest: () => this.loadJsonFromUrl(mapUrl("manifest.json")),
      webpPath: mapUrl("thumbnail.webp"),
    } satisfies MapData;

    this.maps.set(map, mapData);
    return mapData;
  }

  private resolveUrl(path: string): string {
    if (typeof this.pathResolver === "function") {
      return this.pathResolver(path);
    }
    return `${this.pathResolver}/${path}`;
  }

  private url(map: string, path: string) {
    return this.resolveUrl(`${map}/${path}`);
  }

  private async loadBinaryFromUrl(url: string) {
    const startTime = performance.now();
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.statusText}`);
    }

    const data = await response.arrayBuffer();
    console.log(
      `[MapLoader] ${url}: ${(performance.now() - startTime).toFixed(0)}ms`,
    );
    return new Uint8Array(data);
  }

  private async loadJsonFromUrl(url: string) {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.statusText}`);
    }

    return response.json();
  }
}
