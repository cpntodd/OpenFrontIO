package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
)

const previewMaxDimension = 1200

// GeneratePreview returns a compact, colorized PNG of the normalized terrain
// input. It intentionally does not run cleanup or write any map binaries, so
// previewing is safe to repeat while the user adjusts settings.
func GeneratePreview(args GeneratorArgs) ([]byte, int, int, error) {
	img, err := prepareInputImage(args)
	if err != nil {
		return nil, 0, 0, err
	}
	bounds := img.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width < 1 || height < 1 {
		return nil, 0, 0, fmt.Errorf("source image has no pixels")
	}

	scale := math.Min(1, math.Min(float64(previewMaxDimension)/float64(width), float64(previewMaxDimension)/float64(height)))
	previewWidth := maxInt(1, int(math.Round(float64(width)*scale)))
	previewHeight := maxInt(1, int(math.Round(float64(height)*scale)))
	preview := image.NewRGBA(image.Rect(0, 0, previewWidth, previewHeight))
	for y := 0; y < previewHeight; y++ {
		for x := 0; x < previewWidth; x++ {
			sourceX := bounds.Min.X + minInt(width-1, int(float64(x)/scale))
			sourceY := bounds.Min.Y + minInt(height-1, int(float64(y)/scale))
			preview.Set(x, y, previewColor(img.At(sourceX, sourceY)))
		}
	}

	var output bytes.Buffer
	if err := png.Encode(&output, preview); err != nil {
		return nil, 0, 0, fmt.Errorf("failed to encode preview: %w", err)
	}
	return output.Bytes(), width, height, nil
}

func previewColor(c color.Color) color.Color {
	r, g, b, a := c.RGBA()
	if a>>8 < 20 || b>>8 == 106 {
		return color.RGBA{R: 30, G: 106, B: 170, A: 255}
	}
	if r>>8 == 0 && g>>8 == 0 && b>>8 == 0 {
		return color.RGBA{R: 18, G: 24, B: 32, A: 255}
	}
	value := float64(b >> 8)
	amount := math.Max(0, math.Min(1, (value-140)/90))
	return color.RGBA{
		R: uint8(48 + math.Round(amount*180)),
		G: uint8(112 + math.Round(amount*110)),
		B: uint8(62 + math.Round(amount*125)),
		A: 255,
	}
}
