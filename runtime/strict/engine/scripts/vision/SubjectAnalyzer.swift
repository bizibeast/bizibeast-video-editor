import AVFoundation
import AppKit
import CoreImage
import CoreVideo
import Darwin
import Foundation
import Vision

struct PixelBox: Codable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct Face: Codable {
    let box: PixelBox
    let confidence: Float
}

struct Frame: Codable {
    let index: Int
    let timeMs: Int
    let faces: [Face]
    let faceAnalysisAvailable: Bool
    let faceAnalysisError: String?
    let subjectBox: PixelBox?
    let subjectConfidence: Float?
    let personAnalysisAvailable: Bool
    let personAnalysisError: String?
    let segmentationAttempted: Bool
    let segmentationAvailable: Bool
    let segmentationError: String?
    let mattePath: String?
    let matteCoverage: Double
    let edgeHaloPx: Double
}

struct TimeRange: Codable {
    let startMs: Int
    let endMs: Int
}

struct Output: Codable {
    let schemaVersion: Int
    let sourceSha256: String
    let sourceBytes: Int
    let width: Int
    let height: Int
    let durationMs: Int
    let sampleFps: Double
    let timeRangeMs: TimeRange
    let frames: [Frame]
}

struct MaskStats {
    let box: PixelBox?
    let coverage: Double
    let edgeHaloPx: Double
}

func topLeftPixels(_ box: CGRect, width: Int, height: Int) -> PixelBox {
    let x = min(width - 1, max(0, Int((box.minX * CGFloat(width)).rounded())))
    let y = min(height - 1, max(0, Int(((1 - box.maxY) * CGFloat(height)).rounded())))
    let maxX = min(width, max(x + 1, Int((box.maxX * CGFloat(width)).rounded())))
    let maxY = min(height, max(y + 1, Int(((1 - box.minY) * CGFloat(height)).rounded())))
    return PixelBox(
        x: x,
        y: y,
        width: maxX - x,
        height: maxY - y
    )
}

func isSHA256(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { byte in
        (48...57).contains(byte) || (97...102).contains(byte)
    }
}

func maskStats(_ buffer: CVPixelBuffer, outputWidth: Int, outputHeight: Int) -> MaskStats {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) else {
        return MaskStats(box: nil, coverage: 0, edgeHaloPx: 0)
    }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    var minX = width
    var minY = height
    var maxX = -1
    var maxY = -1
    var foreground = 0
    var maximumSoftRun = 0
    for y in 0..<height {
        var softRun = 0
        for x in 0..<width {
            let value = base[y * stride + x]
            if value >= 128 {
                foreground += 1
                minX = min(minX, x)
                minY = min(minY, y)
                maxX = max(maxX, x)
                maxY = max(maxY, y)
            }
            if value > 0 && value < 255 {
                softRun += 1
                maximumSoftRun = max(maximumSoftRun, softRun)
            } else {
                softRun = 0
            }
        }
    }
    for x in 0..<width {
        var softRun = 0
        for y in 0..<height {
            let value = base[y * stride + x]
            if value > 0 && value < 255 {
                softRun += 1
                maximumSoftRun = max(maximumSoftRun, softRun)
            } else {
                softRun = 0
            }
        }
    }
    guard maxX >= minX, maxY >= minY else {
        return MaskStats(box: nil, coverage: 0, edgeHaloPx: 0)
    }
    let box = PixelBox(
        x: Int((Double(minX) / Double(width) * Double(outputWidth)).rounded()),
        y: Int((Double(minY) / Double(height) * Double(outputHeight)).rounded()),
        width: Int((Double(maxX - minX + 1) / Double(width) * Double(outputWidth)).rounded()),
        height: Int((Double(maxY - minY + 1) / Double(height) * Double(outputHeight)).rounded())
    )
    let scale = max(Double(outputWidth) / Double(width), Double(outputHeight) / Double(height))
    return MaskStats(
        box: box,
        coverage: Double(foreground) / Double(width * height),
        edgeHaloPx: (Double(maximumSoftRun) * scale).rounded()
    )
}

func writeMask(_ buffer: CVPixelBuffer, to url: URL, width: Int, height: Int, context: CIContext) throws {
    let source = CIImage(cvPixelBuffer: buffer)
    let image = source.transformed(by: CGAffineTransform(
        scaleX: CGFloat(width) / source.extent.width,
        y: CGFloat(height) / source.extent.height
    ))
    guard let cgImage = context.createCGImage(image, from: CGRect(x: 0, y: 0, width: width, height: height)) else {
        throw NSError(domain: "SubjectAnalyzer", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not render person mask"])
    }
    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "SubjectAnalyzer", code: 5, userInfo: [NSLocalizedDescriptionKey: "Could not encode person mask"])
    }
    try png.write(to: url, options: .atomic)
}

func analyse(_ image: CGImage, index: Int, timeMs: Int, matteURL: URL?, context: CIContext) throws -> Frame {
    let faceRequest = VNDetectFaceRectanglesRequest()
    let humanRequest = VNDetectHumanRectanglesRequest()
    var faceAnalysisAvailable = true
    var faceAnalysisError: String?
    do {
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([faceRequest])
    } catch {
        faceAnalysisAvailable = false
        faceAnalysisError = error.localizedDescription
    }
    let faces = (faceRequest.results ?? []).map {
        Face(box: topLeftPixels($0.boundingBox, width: image.width, height: image.height), confidence: $0.confidence)
    }
    var personAnalysisAvailable = true
    var personAnalysisError: String?
    do {
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([humanRequest])
    } catch {
        personAnalysisAvailable = false
        personAnalysisError = error.localizedDescription
    }
    let human = humanRequest.results?.max(by: { $0.confidence < $1.confidence })
    let humanBox = human.map { topLeftPixels($0.boundingBox, width: image.width, height: image.height) }
    guard let matteURL else {
        return Frame(index: index, timeMs: timeMs, faces: faces, faceAnalysisAvailable: faceAnalysisAvailable,
                     faceAnalysisError: faceAnalysisError, subjectBox: humanBox,
                     subjectConfidence: human?.confidence, personAnalysisAvailable: personAnalysisAvailable,
                     personAnalysisError: personAnalysisError, segmentationAttempted: false,
                     segmentationAvailable: false, segmentationError: nil, mattePath: nil, matteCoverage: 0, edgeHaloPx: 0)
    }
    let segmentation = VNGeneratePersonSegmentationRequest()
    segmentation.qualityLevel = .accurate
    segmentation.outputPixelFormat = kCVPixelFormatType_OneComponent8
    do {
        try VNImageRequestHandler(cgImage: image, orientation: .up).perform([segmentation])
    } catch {
        return Frame(index: index, timeMs: timeMs, faces: faces, faceAnalysisAvailable: faceAnalysisAvailable,
                     faceAnalysisError: faceAnalysisError, subjectBox: humanBox, subjectConfidence: human?.confidence,
                     personAnalysisAvailable: personAnalysisAvailable, personAnalysisError: personAnalysisError,
                     segmentationAttempted: true, segmentationAvailable: false, segmentationError: error.localizedDescription,
                     mattePath: nil, matteCoverage: 0, edgeHaloPx: 0)
    }
    personAnalysisAvailable = true
    personAnalysisError = nil
    guard let observation = segmentation.results?.first else {
        return Frame(index: index, timeMs: timeMs, faces: faces, faceAnalysisAvailable: faceAnalysisAvailable,
                     faceAnalysisError: faceAnalysisError, subjectBox: humanBox, subjectConfidence: human?.confidence,
                     personAnalysisAvailable: personAnalysisAvailable, personAnalysisError: personAnalysisError,
                     segmentationAttempted: true, segmentationAvailable: true, segmentationError: nil,
                     mattePath: nil, matteCoverage: 0, edgeHaloPx: 0)
    }
    let stats = maskStats(observation.pixelBuffer, outputWidth: image.width, outputHeight: image.height)
    guard stats.box != nil else {
        return Frame(index: index, timeMs: timeMs, faces: faces, faceAnalysisAvailable: faceAnalysisAvailable,
                     faceAnalysisError: faceAnalysisError, subjectBox: nil, subjectConfidence: nil,
                     personAnalysisAvailable: personAnalysisAvailable, personAnalysisError: personAnalysisError,
                     segmentationAttempted: true, segmentationAvailable: true, segmentationError: nil,
                     mattePath: nil, matteCoverage: 0, edgeHaloPx: 0)
    }
    do {
        try writeMask(observation.pixelBuffer, to: matteURL, width: image.width, height: image.height, context: context)
    } catch {
        return Frame(index: index, timeMs: timeMs, faces: faces, faceAnalysisAvailable: faceAnalysisAvailable,
                     faceAnalysisError: faceAnalysisError, subjectBox: stats.box,
                     subjectConfidence: observation.confidence, personAnalysisAvailable: personAnalysisAvailable,
                     personAnalysisError: personAnalysisError, segmentationAttempted: true,
                     segmentationAvailable: false, segmentationError: error.localizedDescription,
                     mattePath: nil, matteCoverage: stats.coverage, edgeHaloPx: stats.edgeHaloPx)
    }
    return Frame(index: index, timeMs: timeMs, faces: faces, faceAnalysisAvailable: faceAnalysisAvailable,
                 faceAnalysisError: faceAnalysisError, subjectBox: stats.box,
                 subjectConfidence: observation.confidence, personAnalysisAvailable: personAnalysisAvailable,
                 personAnalysisError: personAnalysisError, segmentationAttempted: true,
                 segmentationAvailable: true, segmentationError: nil, mattePath: matteURL.lastPathComponent,
                 matteCoverage: stats.coverage, edgeHaloPx: stats.edgeHaloPx)
}

func runSubjectAnalyzer() throws {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 5, isSHA256(arguments[1]),
              let sampleFPS = Double(arguments[4]), sampleFPS > 0, sampleFPS <= 60 else {
            FileHandle.standardError.write(Data("Usage: SubjectAnalyzer <source> <sha256> <output.json> <matte-dir|-> <sample-fps>\n".utf8))
            exit(2)
        }
        let source = URL(fileURLWithPath: arguments[0])
        let output = URL(fileURLWithPath: arguments[2])
        let matteDirectory = arguments[3] == "-" ? nil : URL(fileURLWithPath: arguments[3], isDirectory: true)
        var sourceInfo = stat()
        guard lstat(source.path, &sourceInfo) == 0, sourceInfo.st_mode & S_IFMT == S_IFREG else {
            throw NSError(domain: "SubjectAnalyzer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Source must be a no-follow regular file"])
        }
        if let matteDirectory {
            try FileManager.default.createDirectory(at: matteDirectory, withIntermediateDirectories: false)
        }
        let asset = AVURLAsset(url: source)
        let durationSeconds = CMTimeGetSeconds(asset.duration)
        guard durationSeconds.isFinite, durationSeconds > 0 else {
            throw NSError(domain: "SubjectAnalyzer", code: 6, userInfo: [NSLocalizedDescriptionKey: "Source duration is invalid"])
        }
        guard let track = asset.tracks(withMediaType: .video).first else {
            throw NSError(domain: "SubjectAnalyzer", code: 7, userInfo: [NSLocalizedDescriptionKey: "Source has no video track"])
        }
        let transformed = track.naturalSize.applying(track.preferredTransform)
        let expectedWidth = Int(abs(transformed.width).rounded())
        let expectedHeight = Int(abs(transformed.height).rounded())
        guard expectedWidth > 0, expectedHeight > 0 else {
            throw NSError(domain: "SubjectAnalyzer", code: 8, userInfo: [NSLocalizedDescriptionKey: "Decoded dimensions are invalid"])
        }
        let durationMs = Int((durationSeconds * 1000).rounded())
        let sampleCount = max(1, Int(ceil(durationSeconds * sampleFPS)))
        let context = CIContext(options: [.cacheIntermediates: false])
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        let tolerance = CMTime(seconds: 0.5 / sampleFPS, preferredTimescale: 600_000)
        generator.requestedTimeToleranceBefore = tolerance
        generator.requestedTimeToleranceAfter = tolerance
        var frames: [Frame] = []
        var decodedSize: (Int, Int)?
        for index in 0..<sampleCount {
            let requested = CMTime(seconds: Double(index) / sampleFPS, preferredTimescale: 600_000)
            var actual = CMTime.invalid
            let image = try generator.copyCGImage(at: requested, actualTime: &actual)
            let size = (image.width, image.height)
            if let decodedSize, decodedSize != size {
                throw NSError(domain: "SubjectAnalyzer", code: 9, userInfo: [NSLocalizedDescriptionKey: "Decoded dimensions changed between samples"])
            }
            decodedSize = size
            guard size.0 == expectedWidth, size.1 == expectedHeight else {
                throw NSError(domain: "SubjectAnalyzer", code: 10, userInfo: [NSLocalizedDescriptionKey: "Decoded frame does not match transformed track dimensions"])
            }
            let timeMs = Int((CMTimeGetSeconds(actual) * 1000).rounded())
            if let previous = frames.last, timeMs <= previous.timeMs {
                throw NSError(domain: "SubjectAnalyzer", code: 11, userInfo: [NSLocalizedDescriptionKey: "Sample times are not monotonic"])
            }
            let matteURL = matteDirectory?.appendingPathComponent(String(format: "%06d.png", index), isDirectory: false)
            frames.append(try analyse(image, index: index, timeMs: timeMs, matteURL: matteURL, context: context))
        }
        let result = Output(
            schemaVersion: 1,
            sourceSha256: arguments[1],
            sourceBytes: Int(sourceInfo.st_size),
            width: decodedSize?.0 ?? expectedWidth,
            height: decodedSize?.1 ?? expectedHeight,
            durationMs: durationMs,
            sampleFps: sampleFPS,
            timeRangeMs: TimeRange(startMs: 0, endMs: durationMs),
            frames: frames
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(result).write(to: output, options: .atomic)
}

do {
    try runSubjectAnalyzer()
} catch {
    let failure = error as NSError
    FileHandle.standardError.write(Data("SubjectAnalyzer: \(failure.domain) \(failure.code): \(failure.localizedDescription)\n".utf8))
    exit(1)
}
