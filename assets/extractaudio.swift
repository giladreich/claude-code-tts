// Audio extraction/decoding helper for the Claude Code TTS VSCode extension
// (macOS). Reads the first audio track of any AVFoundation-readable file
// (mp4/mov/m4v video, mp3, m4a, aac, wav, aiff, flac, caf, ...) and writes a
// 24kHz mono 16-bit PCM WAV. Optional start/end seconds limit the range.
//   extractaudio <input> <output.wav> [start] [end]
// Prints one JSON line: {"ok":true,"seconds":12.3} or {"ok":false,"error":"..."}.
// Runs 100% locally.
import AVFoundation
import Foundation

func fail(_ msg: String) -> Never {
    print("{\"ok\":false,\"error\":\"\(msg.replacingOccurrences(of: "\"", with: "'"))\"}")
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: extractaudio <input> <output.wav> [start] [end]") }
let input = URL(fileURLWithPath: args[1])
let output = URL(fileURLWithPath: args[2])
let startSec = args.count > 3 ? Double(args[3]) ?? 0 : 0
let endSec = args.count > 4 ? Double(args[4]) ?? 0 : 0

let asset = AVURLAsset(url: input)
let sem = DispatchSemaphore(value: 0)
asset.loadValuesAsynchronously(forKeys: ["tracks", "duration"]) { sem.signal() }
sem.wait()
guard let track = asset.tracks(withMediaType: .audio).first else { fail("no audio track in file") }
let duration = CMTimeGetSeconds(asset.duration)

guard let reader = try? AVAssetReader(asset: asset) else { fail("cannot read file") }
let settings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: 24000,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false,
]
let out = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
out.alwaysCopiesSampleData = false
reader.add(out)
if startSec > 0 || endSec > 0 {
    let s = max(0, startSec)
    let e = endSec > 0 ? min(endSec, duration) : duration
    if e <= s { fail("end must be after start") }
    reader.timeRange = CMTimeRange(start: CMTime(seconds: s, preferredTimescale: 24000), end: CMTime(seconds: e, preferredTimescale: 24000))
}
guard reader.startReading() else { fail("cannot decode: \(reader.error?.localizedDescription ?? "unknown")") }

var pcm = Data()
while let sample = out.copyNextSampleBuffer() {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
    let len = CMBlockBufferGetDataLength(block)
    var bytes = [UInt8](repeating: 0, count: len)
    CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: len, destination: &bytes)
    pcm.append(contentsOf: bytes)
}
if reader.status == .failed { fail("decode failed: \(reader.error?.localizedDescription ?? "unknown")") }
if pcm.isEmpty { fail("no audio decoded") }

func le32(_ v: UInt32) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)] }
func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff)] }
var wav = Data()
wav.append(contentsOf: Array("RIFF".utf8)); wav.append(contentsOf: le32(UInt32(36 + pcm.count)))
wav.append(contentsOf: Array("WAVE".utf8)); wav.append(contentsOf: Array("fmt ".utf8))
wav.append(contentsOf: le32(16)); wav.append(contentsOf: le16(1)); wav.append(contentsOf: le16(1))
wav.append(contentsOf: le32(24000)); wav.append(contentsOf: le32(48000)); wav.append(contentsOf: le16(2)); wav.append(contentsOf: le16(16))
wav.append(contentsOf: Array("data".utf8)); wav.append(contentsOf: le32(UInt32(pcm.count)))
wav.append(pcm)
do { try wav.write(to: output) } catch { fail("cannot write output: \(error.localizedDescription)") }
print("{\"ok\":true,\"seconds\":\(Double(pcm.count) / 48000.0)}")
