// Test-only: build a small .mov with a black video track and an AAC audio
// track from a WAV, so video audio extraction can be tested offline.
//   makevideo <input.wav> <output.mov>
import AVFoundation
import Foundation

let args = CommandLine.arguments
let wavURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
try? FileManager.default.removeItem(at: outURL)

let audioAsset = AVURLAsset(url: wavURL)
let audioTrack = audioAsset.tracks(withMediaType: .audio).first!
let seconds = CMTimeGetSeconds(audioAsset.duration)

let writer = try! AVAssetWriter(outputURL: outURL, fileType: .mov)
let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64,
])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoIn, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64,
])
let audioIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 96000,
])
writer.add(videoIn); writer.add(audioIn)
writer.startWriting(); writer.startSession(atSourceTime: .zero)

let reader = try! AVAssetReader(asset: audioAsset)
let out = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
])
reader.add(out); reader.startReading()

// The writer interleaves tracks, so each input is fed on its own queue as
// the writer asks for data (feeding one track to the end first deadlocks).
let group = DispatchGroup()
var pb: CVPixelBuffer?
CVPixelBufferCreate(nil, 64, 64, kCVPixelFormatType_32BGRA, nil, &pb)
let frames = Int(seconds * 2)
var frame = 0
group.enter()
videoIn.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
    while videoIn.isReadyForMoreMediaData {
        if frame >= frames { videoIn.markAsFinished(); group.leave(); return }
        adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 2))
        frame += 1
    }
}
group.enter()
audioIn.requestMediaDataWhenReady(on: DispatchQueue(label: "audio")) {
    while audioIn.isReadyForMoreMediaData {
        guard let s = out.copyNextSampleBuffer() else { audioIn.markAsFinished(); group.leave(); return }
        audioIn.append(s)
    }
}
group.wait()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
print(writer.status == .completed ? "ok" : "failed: \(writer.error?.localizedDescription ?? "?")")
