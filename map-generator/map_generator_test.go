package main

import (
	"bytes"
	"context"
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
