import Foundation
import Security

guard CommandLine.arguments.count == 4 else {
    FileHandle.standardError.write(Data("invalid arguments\n".utf8))
    exit(64)
}

let operation = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
let service = CommandLine.arguments[3]
let query: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword,
    kSecAttrAccount: account,
    kSecAttrService: service,
]

switch operation {
case "store":
    let credential = FileHandle.standardInput.readDataToEndOfFile()
    guard !credential.isEmpty else {
        FileHandle.standardError.write(Data("empty credential\n".utf8))
        exit(65)
    }
    let update: [CFString: Any] = [kSecValueData: credential]
    var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData] = credential
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
        FileHandle.standardError.write(Data("keychain update failed: \(status)\n".utf8))
        exit(1)
    }
case "read":
    var readQuery = query
    readQuery[kSecMatchLimit] = kSecMatchLimitOne
    readQuery[kSecReturnData] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(readQuery as CFDictionary, &result)
    guard status == errSecSuccess, let credential = result as? Data, !credential.isEmpty else {
        FileHandle.standardError.write(Data("keychain read failed: \(status)\n".utf8))
        exit(1)
    }
    FileHandle.standardOutput.write(credential)
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        FileHandle.standardError.write(Data("keychain delete failed: \(status)\n".utf8))
        exit(1)
    }
default:
    FileHandle.standardError.write(Data("invalid operation\n".utf8))
    exit(64)
}
