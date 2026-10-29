; Personalizaciones del instalador de BoneYardDog (electron-builder / NSIS).
; Una página propia pregunta si se quiere un acceso directo en el ESCRITORIO (el del menú Inicio se crea siempre).
; En instalación silenciosa (/S) no hay páginas: no se crea el del escritorio.

!ifndef BUILD_UNINSTALLER
  Var BYD_DesktopCheckbox
  Var BYD_DesktopState
!endif

!macro customPageAfterChangeDir
  !ifndef BUILD_UNINSTALLER
    Function BYD_AccesoPage
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "Accesos directos" "Elige si quieres un acceso directo en el escritorio."
      ${NSD_CreateLabel} 0 0 100% 24u "El acceso del menú Inicio se crea siempre. Marca la casilla si también lo quieres en el escritorio."
      Pop $0
      ${NSD_CreateCheckbox} 0 34u 100% 12u "Crear un acceso directo en el escritorio"
      Pop $BYD_DesktopCheckbox
      ${NSD_SetState} $BYD_DesktopCheckbox $BYD_DesktopState
      nsDialogs::Show
    FunctionEnd

    Function BYD_AccesoLeave
      ${NSD_GetState} $BYD_DesktopCheckbox $BYD_DesktopState
    FunctionEnd

    Page custom BYD_AccesoPage BYD_AccesoLeave
  !endif
!macroend

!macro customInstall
  ${If} $BYD_DesktopState == 1
    CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  ${EndIf}
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
!macroend
