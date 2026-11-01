// ox-keys: ox's API keys in the macOS Keychain, readable only by this signed helper.
// Any other program (a script, another app, malware running as you) that asks the
// Keychain for them gets a macOS prompt you can refuse, instead of the file it
// could read silently before (~/.ox/keys.json).
//
//   ox-keys get <name>          the secret on stdout (exit 1 when there is none)
//   ox-keys set <name>          the secret from stdin
//   ox-keys delete <name>
import Foundation
import Security

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write(Data("usage: ox-keys get|set|delete <name>\n".utf8)); exit(2) }
let service = "dev.ox.keys"
let account = args[2]

func base() -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] }

/// Only this helper is trusted to read the item without asking you.
func onlyMe() -> SecAccess? {
    var me: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath(nil, &me) == errSecSuccess, let me else { return nil }
    var access: SecAccess?
    guard SecAccessCreate("ox API keys" as CFString, [me] as CFArray, &access) == errSecSuccess else { return nil }
    return access
}

switch args[1] {
case "get":
    var q = base(); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    guard st == errSecSuccess, let d = out as? Data else { exit(st == errSecItemNotFound ? 1 : 3) }
    FileHandle.standardOutput.write(d)
case "set":
    let value = FileHandle.standardInput.readDataToEndOfFile()
    SecItemDelete(base() as CFDictionary)
    var add = base(); add[kSecValueData as String] = value
    add[kSecAttrLabel as String] = "ox API keys"
    if let a = onlyMe() { add[kSecAttrAccess as String] = a }
    let st = SecItemAdd(add as CFDictionary, nil)
    if st != errSecSuccess { FileHandle.standardError.write(Data("keychain error \(st)\n".utf8)); exit(3) }
case "delete":
    let st = SecItemDelete(base() as CFDictionary)
    exit(st == errSecSuccess || st == errSecItemNotFound ? 0 : 3)
default:
    exit(2)
}
