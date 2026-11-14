# Mirror the photo library to the external drive every night
$src = "$env:USERPROFILE\Pictures"
$dst = 'E:\Backups\Pictures'
robocopy $src $dst /MIR /R:2 /W:5 /LOG+:$dst\backup.log
