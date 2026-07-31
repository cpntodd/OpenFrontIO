package main

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestGenerateMapFromSeedIsDeterministic(t *testing.T) {
	args := GeneratorArgs{
		Name:        "seed-test",
		Seed:        "coastline! 42 / alpha",
		Width:       128,
		Height:      128,
		RemoveSmall: false,
	}

	first, err := GenerateMap(context.Background(), args)
	if err != nil {
		t.Fatalf("first generation failed: %v", err)
	}
	second, err := GenerateMap(context.Background(), args)
	if err != nil {
		t.Fatalf("second generation failed: %v", err)
	}

	if !bytes.Equal(first.Map.Data, second.Map.Data) {
		t.Fatal("same seed produced different map data")
	}
	if !bytes.Equal(first.Thumbnail, second.Thumbnail) {
		t.Fatal("same seed produced different thumbnails")
	}
}

func TestSeedRequiresPrintableASCII(t *testing.T) {
	if _, err := generateSeedImage("line\nbreak", 64, 64); err == nil {
		t.Fatal("expected non-printable seed to be rejected")
	}
}

func TestPreviewConvertsOrdinaryJPEG(t *testing.T) {
	input := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for x := 0; x < 32; x++ {
		for y := 0; y < 32; y++ {
			if x < 16 {
				input.Set(x, y, color.RGBA{R: 20, G: 40, B: 60, A: 255})
			} else {
				input.Set(x, y, color.RGBA{R: 240, G: 220, B: 180, A: 255})
			}
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, input, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("failed to encode test JPEG: %v", err)
	}

	preview, width, height, err := GeneratePreview(GeneratorArgs{
		ImageBuffer:          encoded.Bytes(),
		ConvertImage:         true,
		WaterLevel:           120,
		WaterLevelSet:        true,
		MountainThreshold:    205,
		MountainThresholdSet: true,
		Contrast:             110,
	})
	if err != nil {
		t.Fatalf("ordinary image preview failed: %v", err)
	}
	if width != 32 || height != 32 || len(preview) == 0 {
		t.Fatalf("unexpected preview result: %dx%d, %d bytes", width, height, len(preview))
	}
	if _, err := png.Decode(bytes.NewReader(preview)); err != nil {
		t.Fatalf("preview is not a PNG: %v", err)
	}
}

func TestSeedDimensionLimit(t *testing.T) {
	if _, err := generateSeedImage("large", maxSeedMapDimension+1, 32); err == nil {
		t.Fatal("expected seed larger than the supported maximum to be rejected")
	}
}
