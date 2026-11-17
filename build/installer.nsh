; Passos extras do instalador da Ponte.
; Libera o app no Firewall do Windows em todos os perfis de rede. A rede do
; Radmin VPN costuma ser classificada como "Publica" e, sem esta regra, o
; amigo nao aparece.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Ponte"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Ponte" dir=in action=allow program="$INSTDIR\Ponte.exe" profile=any enable=yes'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Ponte"'
!macroend
