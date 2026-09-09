// Persistent, gapless, streaming-capable audio player for the Claude Code TTS
// VSCode extension (macOS). Built on AVAudioEngine so audio parts can be
// appended while earlier parts play (streaming synthesis), with live
// pitch-preserving rate, volume, pause/resume, and stop.
//
// Commands, one JSON object per stdin line:
//   {"play": "/a.wav", "id": 7, "rate": 1.2, "volume": 0.9, "final": true}  start stream 7
//   {"append": "/b.wav", "final": false}   queue the next part of the current stream
//   {"rate": 1.5} {"volume": 0.5} {"pause": true} {"resume": true} {"stop": true}
// Replies carry the stream id they refer to, so a "done" caused by stopping
// stream 7 can never be mistaken for the completion of stream 8 that was
// started right after it:
//   {"done":true,"id":7}                   all parts played (final received)
//   {"done":true,"id":7,"stopped":true}    stopped by command
//   {"done":false,"id":7,"error":"..."}    the first file could not be opened
import AVFoundation
import Foundation

setbuf(stdout, nil)
setbuf(stderr, nil)
func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

let engine = AVAudioEngine()
let node = AVAudioPlayerNode()
let pitch = AVAudioUnitTimePitch()
// More overlap = cleaner time-stretch of speech at the cost of a little CPU
// (default 8; range 3-32).
pitch.overlap = 8
engine.attach(node)
engine.attach(pitch)

// Rule: never call node.stop()/pause() while holding this lock. Those calls
// synchronously invoke pending completion handlers on another thread, and a
// handler that then waits for the lock deadlocks the player (it showed up as
// a player that stopped answering after a skip).
let lock = NSRecursiveLock()
var generation = 0
var streamId = 0
var connectedFormat: AVAudioFormat?
var scheduled = 0
var played = 0
var finalReceived = false
var pausedFlag = false
var streamStart = Date()
var openFiles: [AVAudioFile] = [] // keep files alive until their part played
var lastActivity = Date()

// Rate is applied immediately: only explicit user changes reach here now
// (catch-up is decided per chunk by the extension), and repeated small
// parameter writes on the time-pitch unit are themselves audible.
// AVAudioUnitTimePitch handles 1/32...32; 0.5-3.0 is the useful speech range
// (past 3x speech stops being followable, below 0.5x it drawls).
//
// At exactly 1.0 the unit is bypassed rather than left running at unity: a
// phase vocoder colours what it processes even when it retimes nothing.
// Measured on a cloned voice, rate 1.02 turned a full-scale utterance into
// peaks of 1.36 (+2.7 dB) that the output clipped, the first 0.19s in, which
// is the metallic edge on a first syllable; bypassed, the same audio comes
// out of the graph sample for sample. The extension snaps near-unity rates
// to 1 (playbackTempo) so this is the common case, not a rare one.
func setRate(_ r: Float, immediate: Bool = false) {
    let rate = max(0.4, min(3.0, r))
    pitch.rate = rate
    pitch.bypass = rate == 1.0
}
var underruns = 0

// After a while without audio, release the output device: a fresh
// engine.start() on the next utterance picks up whatever device is current
// (headset connected meanwhile, one that dozed off, ...), which a long-held
// connection would not.
let idleQueue = DispatchQueue(label: "idle")
var idleTimer: DispatchSourceTimer?
func scheduleIdleRelease() {
    idleTimer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: idleQueue)
    t.schedule(deadline: .now() + 20)
    t.setEventHandler {
        lock.lock()
        if scheduled == played && engine.isRunning {
            engine.stop()
            log("idle: released the output device")
        }
        lock.unlock()
    }
    idleTimer = t
    t.resume()
}

func ensureEngine(format: AVAudioFormat) {
    if connectedFormat == nil || connectedFormat! != format {
        if engine.isRunning { engine.stop() }
        engine.disconnectNodeOutput(node)
        engine.disconnectNodeOutput(pitch)
        engine.connect(node, to: pitch, format: format)
        engine.connect(pitch, to: engine.mainMixerNode, format: format)
        connectedFormat = format
    }
    if !engine.isRunning {
        let t = Date()
        do { try engine.start() } catch { log("engine start failed: \(error)") }
        log("engine started in \(Int(Date().timeIntervalSince(t) * 1000))ms")
    }
}

// Output device changes (Bluetooth headset connects/disconnects) require a
// restart of the engine; without it audio silently stops.
NotificationCenter.default.addObserver(
    forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
) { _ in
    lock.lock()
    log("engine configuration changed (output device?) - restarting")
    if let f = connectedFormat {
        connectedFormat = nil
        ensureEngine(format: f)
        if !pausedFlag { node.play() }
    }
    lock.unlock()
}

func emitDone(_ gen: Int, id: Int, reason: String) {
    log("done gen=\(gen) id=\(id) \(reason) after \(String(format: "%.2f", Date().timeIntervalSince(streamStart)))s")
    print(reason == "stopped" ? "{\"done\":true,\"id\":\(id),\"stopped\":true}" : "{\"done\":true,\"id\":\(id)}")
}

func schedule(path: String, gen: Int, id: Int, isFinal: Bool) -> Bool {
    do {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        ensureEngine(format: file.processingFormat)
        openFiles.append(file)
        scheduled += 1
        if isFinal { finalReceived = true }
        node.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { _ in
            lock.lock()
            if gen != generation { lock.unlock(); return } // stream was stopped/superseded
            played += 1
            openFiles.removeAll { $0 === file }
            let complete = finalReceived && played >= scheduled
            if !finalReceived && played >= scheduled {
                // The next part has not arrived yet: an audible gap follows.
                underruns += 1
                log("underrun gen=\(gen) id=\(id) after part \(played) (synthesis slower than playback)")
            }
            lock.unlock()
            if complete { emitDone(gen, id: id, reason: "complete"); scheduleIdleRelease() }
        }
        if !node.isPlaying && !pausedFlag { node.play() }
        return true
    } catch {
        log("cannot open \(path): \(error.localizedDescription)")
        return false
    }
}

print("{\"ready\":true}")

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { continue }

    if let path = obj["play"] as? String {
        lock.lock()
        generation += 1 // before stop(): pending callbacks must see a stale generation
        lock.unlock()
        node.stop() // outside the lock: fires stale completion handlers
        // The time-pitch unit holds a delay line across a stop, so the tail
        // of the utterance just abandoned would be flushed into the opening
        // of this one (measured at -48 dBFS over 80ms).
        pitch.reset()
        lock.lock()
        let gen = generation
        streamId = Int(truncating: (obj["id"] as? NSNumber) ?? 0)
        let id = streamId
        scheduled = 0; played = 0; openFiles.removeAll()
        finalReceived = false
        pausedFlag = false
        streamStart = Date()
        idleTimer?.cancel()
        setRate(Float(truncating: (obj["rate"] as? NSNumber) ?? 1.0), immediate: true)
        node.volume = max(0.0, min(1.0, Float(truncating: (obj["volume"] as? NSNumber) ?? 1.0)))
        let isFinal = (obj["final"] as? Bool) ?? true
        let ok = schedule(path: path, gen: gen, id: id, isFinal: isFinal)
        log("play gen=\(gen) id=\(id) ok=\(ok) final=\(isFinal) rate=\(pitch.rate) stretch=\(pitch.bypass ? "off" : "on") vol=\(node.volume) engine=\(engine.isRunning) file=\(path)")
        lock.unlock()
        if !ok { print("{\"done\":false,\"id\":\(id),\"error\":\"cannot open audio file\"}") }
    } else if let path = obj["append"] as? String {
        lock.lock()
        let gen = generation
        let id = streamId
        let isFinal = (obj["final"] as? Bool) ?? false
        let ok = schedule(path: path, gen: gen, id: id, isFinal: isFinal)
        log("append gen=\(gen) id=\(id) ok=\(ok) final=\(isFinal) queued=\(scheduled - played)")
        lock.unlock()
    } else if obj["end"] != nil {
        // Stream has no more parts; done fires once everything scheduled played.
        lock.lock()
        finalReceived = true
        let complete = played >= scheduled
        let gen = generation
        let id = streamId
        lock.unlock()
        if complete { emitDone(gen, id: id, reason: "end") }
    } else if let r = obj["rate"] as? NSNumber {
        lock.lock(); setRate(Float(truncating: r)); lock.unlock()
    } else if let v = obj["volume"] as? NSNumber {
        lock.lock(); node.volume = max(0.0, min(1.0, Float(truncating: v))); lock.unlock()
    } else if obj["pause"] != nil {
        lock.lock(); pausedFlag = true; lock.unlock()
        node.pause()
    } else if obj["resume"] != nil {
        lock.lock(); pausedFlag = false; if engine.isRunning { node.play() }; lock.unlock()
    } else if obj["stop"] != nil {
        lock.lock()
        let gen = generation
        let id = streamId
        generation += 1 // invalidates pending completion callbacks
        pausedFlag = false
        lock.unlock()
        node.stop() // outside the lock, see above
        lock.lock()
        openFiles.removeAll()
        lock.unlock()
        emitDone(gen, id: id, reason: "stopped")
        scheduleIdleRelease()
    }
}
