; Custom NSIS hooks. electron-builder auto-includes build/installer.nsh.
;
; The app creates its own auto-launch entry at runtime through Electron's
; setLoginItemSettings (a value under HKCU ...\Run named after the appId).
; NSIS knows nothing about that key, so without this hook it survives
; uninstall and points at an executable that no longer exists.
;
; DeleteRegValue on a missing value is harmless, so both the appId form and
; the product-name form are cleared to cover either naming. ${APP_ID} is
; electron-builder's own define, so it tracks appId in electron-builder.yml
; and can't drift from what the app actually writes.

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"

  ; Both cleanups below are skipped during an upgrade, where this uninstaller
  ; runs as a step of the new install: $INSTDIR is about to be reused and the
  ; cached installer may be the very file driving the upgrade.
  ${ifNot} ${isUpdated}
    ; electron-builder's un.onInit does SetOutPath $INSTDIR, which makes the
    ; install folder the uninstaller's working directory. Windows won't delete a
    ; directory that is a live process's CWD, so its own "RMDir /r $INSTDIR"
    ; clears the contents but leaves an empty folder behind forever. Stepping the
    ; working directory out to $TEMP first lets the now-empty folder go.
    ; RMDir (no /r) only removes an empty directory, so this can never eat files.
    SetOutPath "$TEMP"
    RMDir "$INSTDIR"

    ; The installer copies itself to $LOCALAPPDATA\<pkg>-updater\installer.exe
    ; (APP_INSTALLER_STORE_FILE) to serve future updates, and nothing in
    ; electron-builder's uninstaller removes it — an 82 MB orphan per install.
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
    !endif
  ${endIf}
!macroend

; Same cleanup before an upgrade writes a fresh entry, so a stale path from a
; previous install location can't linger.
!macro customInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
!macroend
