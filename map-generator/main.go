package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// mapEntry identifies one map to process: its folder name and whether it
// lives in assets/test_maps instead of assets/maps.
type mapEntry struct {
	Name   string
	IsTest bool
}

// maps holds the registry of maps to process, discovered from the assets
// directories by discoverMaps() at startup.
var maps []mapEntry

// discoverMaps builds the map registry from the filesystem: every folder in
// assets/maps, plus every folder in assets/test_maps as a test map. Adding a
// map is just adding a folder with image.png and info.json.
func discoverMaps() ([]mapEntry, error) {
	var result []mapEntry
	for _, isTest := range []bool{false, true} {
		dir, err := inputMapDir(isTest)
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, fmt.Errorf("failed to read maps directory %s: %w", dir, err)
		}
		for _, entry := range entries {
			if entry.IsDir() {
				result = append(result, mapEntry{Name: entry.Name(), IsTest: isTest})
			}
		}
	}
	return result, nil
}

// mapsFlag holds the comma-separated list of map names passed via the --maps command-line argument.
var mapsFlag string

// Custom generation flags are used by the Electron desktop map-generator
// page. When --map-name and --output are supplied, the CLI generates one map
// from either --input or --seed instead of processing the bundled registry.
var mapNameFlag string
var inputFlag string
var outputFlag string
var seedFlag string
var widthFlag int
var heightFlag int

// workersFlag controls how many maps are processed concurrently, bounding peak memory usage.
var workersFlag int

// logFlags holds all the flags related to configuring the map-generator logging
var logFlags LogFlags

// outputMapDir returns the absolute path to the directory where generated map files should be written.
// It distinguishes between test and production output locations.
func outputMapDir(isTest bool) (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get working directory: %w", err)
	}
	if isTest {
		return filepath.Join(cwd, "..", "tests", "testdata", "maps"), nil
	}
	return filepath.Join(cwd, "..", "resources", "maps"), nil
}

// inputMapDir returns the absolute path to the directory containing source map assets.
// It distinguishes between test and production asset locations.
func inputMapDir(isTest bool) (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("failed to get working directory: %w", err)
	}
	if isTest {
		return filepath.Join(cwd, "assets", "test_maps"), nil
	} else {
		return filepath.Join(cwd, "assets", "maps"), nil
	}
}

// processMap handles the end-to-end generation for a single map.
// It reads the source image and JSON, generates the terrain data, and writes the binary outputs and updated manifest.
func processMap(ctx context.Context, name string, isTest bool) error {
	outputMapBaseDir, err := outputMapDir(isTest)
	if err != nil {
		return fmt.Errorf("failed to get map directory: %w", err)
	}

	inputMapDir, err := inputMapDir(isTest)
	if err != nil {
		return fmt.Errorf("failed to get input map directory: %w", err)
	}

	inputPath := filepath.Join(inputMapDir, name, "image.png")
	imageBuffer, err := os.ReadFile(inputPath)
	if err != nil {
		return fmt.Errorf("failed to read map file %s: %w", inputPath, err)
	}

	// Read the info.json file
	manifestPath := filepath.Join(inputMapDir, name, "info.json")
	manifestBuffer, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("failed to read info file %s: %w", manifestPath, err)
	}

	// Parse the info buffer as dynamic JSON
	var manifest map[string]interface{}
	if err := json.Unmarshal(manifestBuffer, &manifest); err != nil {
		return fmt.Errorf("failed to parse info.json for %s: %w", name, err)
	}

	// Generate maps
	result, err := GenerateMap(ctx, GeneratorArgs{
		ImageBuffer: imageBuffer,
		RemoveSmall: !isTest, // Don't remove small islands for test maps
		Name:        name,
	})
	if err != nil {
		return fmt.Errorf("failed to generate map for %s: %w", name, err)
	}

	manifest["map"] = map[string]interface{}{
		"width":          result.Map.Width,
		"height":         result.Map.Height,
		"num_land_tiles": result.Map.NumLandTiles,
	}
	manifest["map4x"] = map[string]interface{}{
		"width":          result.Map4x.Width,
		"height":         result.Map4x.Height,
		"num_land_tiles": result.Map4x.NumLandTiles,
	}
	manifest["map16x"] = map[string]interface{}{
		"width":          result.Map16x.Width,
		"height":         result.Map16x.Height,
		"num_land_tiles": result.Map16x.NumLandTiles,
	}

	mapDir := filepath.Join(outputMapBaseDir, name)
	return writeGeneratedMap(mapDir, result, manifest)
}

func writeGeneratedMap(mapDir string, result MapResult, manifest map[string]interface{}) error {
	if err := os.MkdirAll(mapDir, 0755); err != nil {
		return fmt.Errorf("failed to create output directory %s: %w", mapDir, err)
	}
	files := map[string][]byte{
		"map.bin":        result.Map.Data,
		"map4x.bin":      result.Map4x.Data,
		"map16x.bin":     result.Map16x.Data,
		"thumbnail.webp": result.Thumbnail,
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(mapDir, name), data, 0644); err != nil {
			return fmt.Errorf("failed to write %s: %w", name, err)
		}
	}

	updatedManifest, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(mapDir, "manifest.json"), updatedManifest, 0644); err != nil {
		return fmt.Errorf("failed to write manifest: %w", err)
	}
	return nil
}

func runCustomGeneration(ctx context.Context) error {
	if mapNameFlag == "" {
		return fmt.Errorf("--map-name is required for custom generation")
	}
	if outputFlag == "" {
		return fmt.Errorf("--output is required for custom generation")
	}
	if inputFlag == "" && seedFlag == "" {
		return fmt.Errorf("either --input or --seed is required for custom generation")
	}
	if inputFlag != "" && seedFlag != "" {
		return fmt.Errorf("--input and --seed cannot be used together")
	}

	var imageBuffer []byte
	if inputFlag != "" {
		var err error
		imageBuffer, err = os.ReadFile(inputFlag)
		if err != nil {
			return fmt.Errorf("failed to read input image %s: %w", inputFlag, err)
		}
	}

	result, err := GenerateMap(ctx, GeneratorArgs{
		Name:        mapNameFlag,
		ImageBuffer: imageBuffer,
		Seed:        seedFlag,
		Width:       widthFlag,
		Height:      heightFlag,
		RemoveSmall: true,
	})
	if err != nil {
		return fmt.Errorf("failed to generate custom map: %w", err)
	}

	manifest := map[string]interface{}{
		"name": mapNameFlag,
		// Custom maps do not have fixed country spawn metadata. Keeping an
		// explicit empty list makes the manifest compatible with the normal
		// solo map loader; users can still choose a numeric nation count.
		"nations": []interface{}{},
		"map": map[string]interface{}{
			"width":          result.Map.Width,
			"height":         result.Map.Height,
			"num_land_tiles": result.Map.NumLandTiles,
		},
		"map4x": map[string]interface{}{
			"width":          result.Map4x.Width,
			"height":         result.Map4x.Height,
			"num_land_tiles": result.Map4x.NumLandTiles,
		},
		"map16x": map[string]interface{}{
			"width":          result.Map16x.Width,
			"height":         result.Map16x.Height,
			"num_land_tiles": result.Map16x.NumLandTiles,
		},
	}
	return writeGeneratedMap(outputFlag, result, manifest)
}

// parseMapsFlag validates and parses the --maps command-line argument.
// It returns a set of selected map names or nil if no flag was provided (implying all maps).
func parseMapsFlag() (map[string]bool, error) {
	if mapsFlag == "" {
		return nil, nil
	}

	validNames := make(map[string]bool, len(maps))
	for _, m := range maps {
		validNames[m.Name] = true
	}

	selected := make(map[string]bool)
	for _, name := range strings.Split(mapsFlag, ",") {
		if !validNames[name] {
			return nil, fmt.Errorf("map %q is not defined", name)
		}
		selected[name] = true
	}
	return selected, nil
}

// loadTerrainMaps manages the concurrent generation of all selected maps.
// It spins up goroutines for each map and aggregates any errors.
// Concurrency is bounded by --workers to cap peak memory usage.
func loadTerrainMaps() error {
	if workersFlag < 1 {
		return fmt.Errorf("--workers must be >= 1, got %d", workersFlag)
	}
	selectedMaps, err := parseMapsFlag()
	if err != nil {
		return err
	}
	var wg sync.WaitGroup
	errChan := make(chan error, len(maps))
	sem := make(chan struct{}, workersFlag)

	// Process maps concurrently, bounded by the semaphore
	for _, mapItem := range maps {
		if selectedMaps != nil && !selectedMaps[mapItem.Name] {
			continue
		}
		wg.Add(1)
		mapItem := mapItem
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			mapLogTag := slog.String("map", mapItem.Name)
			testLogTag := slog.Bool("isTest", mapItem.IsTest)
			logger := slog.Default().With(mapLogTag).With(testLogTag)
			ctx := ContextWithLogger(context.Background(), logger)
			if err := processMap(ctx, mapItem.Name, mapItem.IsTest); err != nil {
				errChan <- err
			}
		}()
	}

	// Wait for all goroutines to complete
	wg.Wait()
	close(errChan)

	// Check for errors
	for err := range errChan {
		if err != nil {
			return err
		}
	}

	return nil
}

// main is the entry point for the map generator tool.
// It parses flags and triggers the map generation process.
func main() {
	flag.StringVar(&mapsFlag, "maps", "", "optional comma-separated list of maps to process. ex: --maps=world,eastasia,big_plains")
	flag.StringVar(&mapNameFlag, "map-name", "", "custom map name")
	flag.StringVar(&inputFlag, "input", "", "custom map source PNG")
	flag.StringVar(&outputFlag, "output", "", "custom map output directory")
	flag.StringVar(&seedFlag, "seed", "", "custom map printable seed")
	flag.IntVar(&widthFlag, "width", 0, "custom seed map width (default 512)")
	flag.IntVar(&heightFlag, "height", 0, "custom seed map height (default 512)")
	flag.IntVar(&workersFlag, "workers", 4, "number of maps to process concurrently. reduce to lower peak memory usage.")
	flag.StringVar(&logFlags.logLevel, "log-level", "", "Explicitly sets the log level to one of: ALL, DEBUG, INFO (default), WARN, ERROR.")
	flag.BoolVar(&logFlags.verbose, "verbose", false, "Adds additional logging and prefixes logs with the [mapname].  Alias of log-level=DEBUG.")
	flag.BoolVar(&logFlags.verbose, "v", false, "-verbose shorthand")
	flag.BoolVar(&logFlags.performance, "log-performance", false, "Adds additional logging for performance-based recommendations, sets log-level=DEBUG")
	flag.BoolVar(&logFlags.removal, "log-removal", false, "Adds additional logging of removed island and lake position/size, sets log-level=DEBUG")
	flag.Parse()

	logger := slog.New(NewGeneratorLogger(
		os.Stdout,
		&slog.HandlerOptions{
			Level: DetermineLogLevel(logFlags),
		},
		logFlags,
	))

	slog.SetDefault(logger)

	if mapNameFlag != "" || inputFlag != "" || outputFlag != "" || seedFlag != "" {
		if err := runCustomGeneration(context.Background()); err != nil {
			log.Fatalf("Error generating custom map: %v", err)
		}
		fmt.Println("Custom map generated successfully")
		return
	}

	discovered, err := discoverMaps()
	if err != nil {
		log.Fatalf("Error discovering maps: %v", err)
	}
	maps = discovered

	if err := loadTerrainMaps(); err != nil {
		log.Fatalf("Error generating terrain maps: %v", err)
	}

	infos, err := loadMapInfos()
	if err != nil {
		log.Fatalf("Error loading map info: %v", err)
	}
	if err := generateMapsTS(infos); err != nil {
		log.Fatalf("Error generating Maps.gen.ts: %v", err)
	}
	if err := generateEnJSON(infos); err != nil {
		log.Fatalf("Error generating en.json map section: %v", err)
	}

	fmt.Println("Terrain maps generated successfully")
}
