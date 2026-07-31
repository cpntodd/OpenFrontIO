import {
  customMapValue,
  type CustomMapEntry,
  type CustomMapList,
  type GameMapName,
  type GameMapType,
  type MapInfo,
} from "../core/game/Game";

let customMapLabels = new Map<GameMapType, string>();

export async function loadCustomMaps(): Promise<MapInfo[]> {
  if (typeof window === "undefined" || !window.electronAPI) return [];

  const result: CustomMapList = await window.electronAPI.mapGen.list();
  if (!result.assetBaseUrl) {
    customMapLabels = new Map();
    return [];
  }

  const infos = result.maps.map((entry) => {
    const value = customMapValue(entry.folder, result.assetBaseUrl!);
    customMapLabels.set(value, entry.name);
    return {
      id: value as unknown as GameMapName,
      type: value,
      translationKey: "",
      categories: ["new"],
      multiplayerFrequency: 0,
    } satisfies MapInfo;
  });

  const currentValues = new Set(infos.map((info) => info.type));
  customMapLabels = new Map(
    [...customMapLabels].filter(([value]) => currentValues.has(value)),
  );
  return infos;
}

export function customMapDisplayName(
  map: MapInfo,
  fallback: string,
): string {
  return customMapLabels.get(map.type) ?? fallback;
}

export type { CustomMapEntry };
