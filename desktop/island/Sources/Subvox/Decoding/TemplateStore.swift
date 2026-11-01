import Foundation

struct Dataset: Codable {
    var vocabulary: [String]
    var templates: [Template]

    static let starter = Dataset(vocabulary: ["yes", "no", "next", "back", "stop"], templates: [])
}

/// Persists the training set as JSON in Application Support.
enum TemplateStore {
    static var url: URL {
        let dir = URL.applicationSupportDirectory.appending(path: "Subvox", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appending(path: "dataset.json")
    }

    static func load() -> Dataset {
        guard let data = try? Data(contentsOf: url),
              let dataset = try? JSONDecoder().decode(Dataset.self, from: data) else { return .starter }
        return dataset
    }

    static func save(_ dataset: Dataset) {
        do {
            let data = try JSONEncoder().encode(dataset)
            try data.write(to: url, options: .atomic)
        } catch {
            print("Subvox: failed to save dataset: \(error)")
        }
    }
}
