*CapsLock::
    Send {Blind}{Ctrl Down}
    cDown := A_TickCount
Return

*CapsLock up::
    ; Modify the threshold time (in milliseconds) as necessary
    If ((A_TickCount-cDown) < 150)
        Send {Blind}{Ctrl Up}{Esc}
    Else
        Send {Blind}{Ctrl up}
Return

;截图软件统一使用flameshot,能截图编辑并能Pin图, 只要启动了flameshot，其快捷键就是PrintScreen
LALT & a::
    If(GetKeyState("Shift", "D"))
        Send, {PrintScreen}
return

