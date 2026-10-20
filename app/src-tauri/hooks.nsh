; Instalação por linha de comando: setup.exe /S /SERVER=http://host:3000
; grava o servidor onde o app procura (server.txt, ver main.rs).
; ${GetOptions} não serve aqui: ele corta o valor na primeira "/" (de "http://").
!include "FileFunc.nsh"
!include "WordFunc.nsh"

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  ${GetParameters} $0
  ${WordFind} "$0" "/SERVER=" "E+1}" $1 ; text after the flag (error if the flag is absent)
  ${IfNot} ${Errors}
    ${WordFind} "$1" " " "+1{" $1 ; up to the next argument
    ${WordFind} "$1" '"' "+1{" $1 ; drop a closing quote of "/SERVER=..."
    ${If} $1 != ""
      CreateDirectory "$APPDATA\app.streamp2p.desktop"
      FileOpen $0 "$APPDATA\app.streamp2p.desktop\server.txt" w
      FileWrite $0 $1
      FileClose $0
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend
