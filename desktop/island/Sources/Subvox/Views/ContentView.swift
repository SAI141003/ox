import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationSplitView {
            List(AppModel.Screen.allCases, selection: screenSelection) { screen in
                Label(screen.rawValue, systemImage: screen.symbol).tag(screen)
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
        } detail: {
            switch model.screen {
            case .sensors: SensorsView()
            case .train: TrainView()
            case .decode: DecodeView()
            }
        }
        .toolbar {
            ToolbarItem(placement: .status) {
                MotionStatusBadge(status: model.motion.status, rate: model.motion.sampleRate)
            }
            ToolbarItem {
                SendToOxToggle()
            }
            ToolbarItem {
                RecordToolbarButton()
            }
        }
        .navigationTitle(model.screen.rawValue)
    }

    private var screenSelection: Binding<AppModel.Screen?> {
        Binding(get: { model.screen }, set: { if let screen = $0 { model.screen = screen } })
    }
}

private struct RecordToolbarButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let recorder = model.recorder
        Button {
            recorder.isRecording ? recorder.stop() : recorder.start(audio: model.audio)
        } label: {
            Label(recorder.isRecording ? "Stop Recording" : "Record Session",
                  systemImage: recorder.isRecording ? "stop.circle.fill" : "record.circle")
        }
        .tint(recorder.isRecording ? .red : nil)
        .help("Record synchronized motion CSV + audio to ~/Documents/Subvox/Sessions")
    }
}
