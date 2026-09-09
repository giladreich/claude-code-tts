// Microphone recorder for Claude Code TTS's voice-cloning flow (macOS).
// Usage: micrecord <out.wav> <maxSeconds>
// Records mono 16-bit PCM at 24kHz until maxSeconds elapse or any line
// (or EOF) arrives on stdin. Prints one JSON result line. Recording stays
// on this machine; macOS shows its microphone permission prompt on first use.
import AVFoundation
import Foundation

setbuf(stdout, nil)
guard CommandLine.arguments.count >= 3 else {
    print("{\"ok\":false,\"error\":\"usage: micrecord <out.wav> <seconds>\"}")
    exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let seconds = Double(CommandLine.arguments[2]) ?? 30
let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatLinearPCM),
    AVSampleRateKey: 24000.0,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
]

do {
    let recorder = try AVAudioRecorder(url: url, settings: settings)
    guard recorder.record() else {
        print("{\"ok\":false,\"error\":\"recording failed - check microphone permission for VSCode\"}")
        exit(1)
    }
    let finish = {
        recorder.stop()
        Thread.sleep(forTimeInterval: 0.3) // let the file finalize
        print("{\"ok\":true}")
        exit(0)
    }
    Thread.detachNewThread {
        _ = readLine() // any line, or EOF, ends the recording early
        finish()
    }
    Thread.sleep(forTimeInterval: seconds)
    finish()
} catch {
    print("{\"ok\":false,\"error\":\"\(error.localizedDescription)\"}")
    exit(1)
}
