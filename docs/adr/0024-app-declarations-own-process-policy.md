# App declarations own process policy

An App is a stable command declaration; a Session is one UUID-identified execution and a Pane is geometry showing its terminal. Local Apps choose keep, stop, or pause when logically hidden, while Companion Apps keep running; explicit Layout Visibility separates intentional hiding from size fitting so narrowing a terminal never terminates work.

This replaces the Session-only API and identity labels without compatibility aliases: agentmux is the sole consumer and upgrades with it. Natural exit retains the declaration without restarting, and downstream supervisors distinguish intentional exit causes from natural exits.
