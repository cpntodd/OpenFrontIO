package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
)

func prepareInputImage(args GeneratorArgs) (image.Image, error) {
	if len(args.ImageBuffer) > 0 && args.Seed != "" {
		return nil, fmt.Errorf("input image and seed cannot be used together")
	}
	if len(args.ImageBuffer) > 0 {
		img, _, err := image.Decode(bytes.NewReader(args.ImageBuffer))
		if err != nil {
			return nil, fmt.Errorf("failed to decode source image: %w", err)
		}
		if args.ConvertImage {
			return convertToHeightMap(img, args)
		}
		return img, nil
	}
	if args.Seed != "" {
		return generateSeedImage(args.Seed, args.Width, args.Height, args)
	}
	return nil, fmt.Errorf("either an input image or a seed is required")
}

func conversionSettings(args GeneratorArgs) (int, int, int, int, bool, error) {
	waterLevel := args.WaterLevel
	if waterLevel == 0 && !args.WaterLevelSet {
		waterLevel = defaultWaterLevel
	}
	mountainThreshold := args.MountainThreshold
	if mountainThreshold == 0 && !args.MountainThresholdSet {
		mountainThreshold = defaultMountainThreshold
	}
	brightness := args.Brightness
	contrast := args.Contrast
	if contrast == 0 {
		contrast = 100
	}
	if waterLevel < 0 || waterLevel > 255 {
		return 0, 0, 0, 0, false, fmt.Errorf("water level must be between 0 and 255")
	}
	if mountainThreshold < 0 || mountainThreshold > 255 {
		return 0, 0, 0, 0, false, fmt.Errorf("mountain threshold must be between 0 and 255")
	}
	if mountainThreshold <= waterLevel {
		return 0, 0, 0, 0, false, fmt.Errorf("mountain threshold must be greater than water level")
	}
	if brightness < -100 || brightness > 100 {
		return 0, 0, 0, 0, false, fmt.Errorf("brightness must be between -100 and 100")
	}
	if contrast < 25 || contrast > 300 {
		return 0, 0, 0, 0, false, fmt.Errorf("contrast must be between 25 and 300 percent")
	}
	return waterLevel, mountainThreshold, brightness, contrast, args.Invert, nil
}

func convertToHeightMap(source image.Image, args GeneratorArgs) (image.Image, error) {
	waterLevel, mountainThreshold, brightness, contrast, invert, err := conversionSettings(args)
	if err != nil {
		return nil, err
	}
	bounds := source.Bounds()
	converted := image.NewRGBA(bounds)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			r, g, b, a := source.At(x, y).RGBA()
			if a>>8 < 20 {
				converted.SetRGBA(x, y, color.RGBA{B: 106, A: 255})
				continue
			}
			value := int(math.Round((0.299*float64(r) + 0.587*float64(g) + 0.114*float64(b)) / 257))
			value = adjustLuminance(value, brightness, contrast, invert)
			converted.SetRGBA(x, y, color.RGBA{B: elevationToBlue(value, waterLevel, mountainThreshold), A: 255})
		}
	}
	return converted, nil
}

func adjustLuminance(value, brightness, contrast int, invert bool) int {
	value = int(math.Round((float64(value-128)*float64(contrast))/100 + 128 + float64(brightness)))
	if invert {
		value = 255 - value
	}
	return maxInt(0, minInt(255, value))
}

func elevationToBlue(value, waterLevel, mountainThreshold int) uint8 {
	if value <= waterLevel {
		return 106
	}
	if value >= mountainThreshold {
		span := maxInt(1, 255-mountainThreshold)
		return uint8(200 + math.Round(float64(value-mountainThreshold)*30/float64(span)))
	}
	span := maxInt(1, mountainThreshold-waterLevel)
	return uint8(140 + math.Round(float64(value-waterLevel)*60/float64(span)))
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
