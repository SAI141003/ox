import SwiftUI
import WebKit

/// The office in the notch (lumiomac's): the same pixel office ox serves at
/// /office, shown here so the island and the app always match.
struct OfficeWeb: NSViewRepresentable {
    let port: Int?
    func makeNSView(context: Context) -> WKWebView {
        let w = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        w.setValue(false, forKey: "drawsBackground")
        load(w)
        return w
    }
    func updateNSView(_ w: WKWebView, context: Context) {
        if w.url == nil || w.url?.port != port { load(w) }
    }
    private func load(_ w: WKWebView) {
        guard let port, let url = URL(string: "http://127.0.0.1:\(port)/office?embed=1") else {
            w.loadHTMLString("<body style='background:#0d0f13;color:#8b919d;font:12px -apple-system;display:grid;place-items:center;height:90vh'>Starting ox…</body>", baseURL: nil)
            return
        }
        w.load(URLRequest(url: url))
    }
}
