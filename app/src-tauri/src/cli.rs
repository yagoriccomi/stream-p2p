// Command line of the app: lets a script (or Claude) open a session, drive the running
// instance and read its state. Pure parsing here so it is unit-tested; main.rs does the I/O.

pub const HELP: &str = "Stream P2P — linha de comando

Abrir:
  --server <url>        Servidor de sinalização (fica salvo para as próximas vezes)
  --create --name <a>   Cria uma sessão com o apelido <a>
  --join <código>       Entra na sessão xxxx-xx (com --name entra direto)
  --name <apelido>      Apelido usado por --create/--join

Controlar o app que já está aberto:
  --show                Traz a janela para a frente
  --stop-stream         Para a transmissão (se você estiver transmitindo)
  --mute                Liga/desliga o microfone
  --copy-invite         Copia o convite para a área de transferência
  --leave               Sai da sessão
  --quit                Fecha o app

Consultar (não abre janela):
  --status              Imprime o estado atual em JSON
  --version             Imprime a versão
  --help                Mostra esta ajuda

Códigos de saída: 0 ok · 2 argumento inválido · 3 app não está aberto";

pub const SCHEME: &str = "streamp2p";

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Query {
    Help,
    Version,
    Status,
}

#[derive(Debug, PartialEq, Clone)]
pub enum Open {
    Home,
    Create { name: String },
    Join { code: String, name: Option<String> },
}

// Commands forwarded to the running instance; the web app handles them like the tray menu.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Remote {
    Show,
    StopStream,
    Mute,
    CopyInvite,
    Leave,
    Quit,
}

impl Remote {
    pub fn event(self) -> &'static str {
        match self {
            Remote::Show => "show",
            Remote::StopStream => "stop",
            Remote::Mute => "mute",
            Remote::CopyInvite => "copy",
            Remote::Leave => "leave",
            Remote::Quit => "quit",
        }
    }
}

#[derive(Debug, PartialEq, Default)]
pub struct Cli {
    pub query: Option<Query>,
    pub server: Option<String>,
    pub open: Option<Open>,
    pub remote: Vec<Remote>,
}

fn value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    match args.next() {
        Some(v) if !v.starts_with("--") && !v.trim().is_empty() => Ok(v.trim().to_string()),
        _ => Err(format!("{flag} precisa de um valor")),
    }
}

pub fn valid_server(url: &str) -> Result<String, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| format!("--server inválido: {url}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(format!("--server precisa ser http(s)://host[:porta]: {url}"));
    }
    Ok(parsed.origin().ascii_serialization())
}

// Same normalization as the server: lowercase, "xxxx-xx".
fn valid_code(code: &str) -> Result<String, String> {
    let c = code.trim().to_lowercase();
    let ok = c.len() == 7 && c.chars().enumerate().all(|(i, ch)| if i == 4 { ch == '-' } else { ch.is_ascii_alphanumeric() });
    if ok { Ok(c) } else { Err(format!("código inválido: {code} (formato xxxx-xx)")) }
}

// argv without the program name. Windows shells pass "/arg" style too rarely to support.
pub fn parse(argv: impl IntoIterator<Item = String>) -> Result<Cli, String> {
    let mut cli = Cli::default();
    let (mut create, mut join, mut name) = (false, None, None);
    let mut args = argv.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => cli.query = Some(Query::Help),
            "--version" | "-V" => cli.query = Some(Query::Version),
            "--status" => cli.query = Some(Query::Status),
            "--server" => cli.server = Some(valid_server(&value(&mut args, "--server")?)?),
            "--create" => create = true,
            "--join" => join = Some(valid_code(&value(&mut args, "--join")?)?),
            "--name" => name = Some(value(&mut args, "--name")?),
            "--show" => cli.remote.push(Remote::Show),
            "--stop-stream" => cli.remote.push(Remote::StopStream),
            "--mute" => cli.remote.push(Remote::Mute),
            "--copy-invite" => cli.remote.push(Remote::CopyInvite),
            "--leave" => cli.remote.push(Remote::Leave),
            "--quit" => cli.remote.push(Remote::Quit),
            // Link "Abrir no app" of the web join screen (scheme registered by hooks.nsh).
            // ponytail: the server is not taken from the link, so a link can't repoint the app;
            // the app opens the code on its own server.
            link if link.starts_with(&format!("{SCHEME}:")) => {
                let url = tauri::Url::parse(link).map_err(|_| format!("link inválido: {link}"))?;
                let get = |k: &str| url.query_pairs().find(|(q, _)| q == k).map(|(_, v)| v.trim().to_string()).filter(|v| !v.is_empty());
                join = Some(valid_code(&get("code").ok_or("link sem código")?)?);
                name = get("name");
            }
            other => return Err(format!("argumento desconhecido: {other}")),
        }
    }
    cli.open = match (create, join, name) {
        (true, Some(_), _) => return Err("use --create ou --join, não os dois".into()),
        (true, None, Some(name)) => Some(Open::Create { name }),
        (true, None, None) => return Err("--create precisa de --name".into()),
        (false, Some(code), name) => Some(Open::Join { code, name }),
        (false, None, Some(_)) => return Err("--name só vale com --create ou --join".into()),
        (false, None, None) => None,
    };
    Ok(cli)
}

// URL the window opens: the web app reads ?create / ?code&name&auto (see web/app.js boot).
pub fn start_url(server: &str, open: &Open) -> tauri::Url {
    let mut url = tauri::Url::parse(server).expect("server already validated");
    {
        let mut q = url.query_pairs_mut();
        match open {
            Open::Home => {}
            Open::Create { name } => {
                q.append_pair("create", "1").append_pair("name", name);
            }
            Open::Join { code, name } => {
                q.append_pair("code", code);
                if let Some(name) = name {
                    q.append_pair("name", name).append_pair("auto", "1");
                }
            }
        }
    }
    if url.query() == Some("") {
        url.set_query(None);
    }
    url
}

// WebView2 flags. WebView2 only exposes screen capture and the mic to secure origins, and a
// server on the LAN is plain http: that one origin is treated as secure. Setting the flags
// replaces Tauri's defaults, so those come first.
pub fn browser_args(server: &str) -> String {
    let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    if server.starts_with("http://") {
        args.push_str(&format!(" --unsafely-treat-insecure-origin-as-secure={server}"));
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Result<Cli, String> {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn no_args_opens_home() {
        assert_eq!(p(&[]).unwrap(), Cli::default());
    }

    #[test]
    fn create_needs_a_name() {
        assert!(p(&["--create"]).is_err());
        assert_eq!(p(&["--create", "--name", "Claude"]).unwrap().open, Some(Open::Create { name: "Claude".into() }));
    }

    #[test]
    fn join_normalizes_the_code_and_rejects_bad_ones() {
        let cli = p(&["--join", "ABCD-EF", "--name", "Bia"]).unwrap();
        assert_eq!(cli.open, Some(Open::Join { code: "abcd-ef".into(), name: Some("Bia".into()) }));
        assert!(p(&["--join", "abc"]).is_err());
        assert!(p(&["--join"]).is_err());
    }

    #[test]
    fn web_link_joins_with_the_name_and_ignores_a_server() {
        let cli = p(&["streamp2p://join/?code=ABCD-EF&name=Z%C3%A9&server=http://evil"]).unwrap();
        assert_eq!(cli.open, Some(Open::Join { code: "abcd-ef".into(), name: Some("Zé".into()) }));
        assert_eq!(cli.server, None);
        assert_eq!(p(&["streamp2p://join/?code=abcd-ef"]).unwrap().open, Some(Open::Join { code: "abcd-ef".into(), name: None }));
        assert!(p(&["streamp2p://join/?code=nope"]).is_err());
        assert!(p(&["streamp2p://join/"]).is_err());
    }

    #[test]
    fn create_and_join_together_is_an_error() {
        assert!(p(&["--create", "--join", "abcd-ef", "--name", "x"]).is_err());
    }

    #[test]
    fn server_must_be_http_and_keeps_only_the_origin() {
        assert_eq!(p(&["--server", "http://192.168.0.10:3000/x?y"]).unwrap().server.as_deref(), Some("http://192.168.0.10:3000"));
        assert!(p(&["--server", "ftp://x"]).is_err());
        assert!(p(&["--server", "--quit"]).is_err());
    }

    #[test]
    fn remote_commands_and_queries() {
        let cli = p(&["--mute", "--stop-stream", "--quit"]).unwrap();
        assert_eq!(cli.remote, vec![Remote::Mute, Remote::StopStream, Remote::Quit]);
        assert_eq!(p(&["--status"]).unwrap().query, Some(Query::Status));
        assert!(p(&["--bogus"]).is_err());
        assert!(p(&["--name", "x"]).is_err());
    }

    #[test]
    fn start_url_carries_what_the_web_app_reads() {
        let s = "http://localhost:3000";
        assert_eq!(start_url(s, &Open::Home).as_str(), "http://localhost:3000/");
        assert_eq!(start_url(s, &Open::Create { name: "Zé Ninguém".into() }).as_str(), "http://localhost:3000/?create=1&name=Z%C3%A9+Ningu%C3%A9m");
        assert_eq!(start_url(s, &Open::Join { code: "abcd-ef".into(), name: None }).as_str(), "http://localhost:3000/?code=abcd-ef");
        assert_eq!(start_url(s, &Open::Join { code: "abcd-ef".into(), name: Some("Bia".into()) }).as_str(), "http://localhost:3000/?code=abcd-ef&name=Bia&auto=1");
    }

    #[test]
    fn a_plain_http_server_is_treated_as_secure() {
        let lan = browser_args("http://192.168.0.10:3000");
        assert!(lan.starts_with("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
        assert!(lan.ends_with(" --unsafely-treat-insecure-origin-as-secure=http://192.168.0.10:3000"));
        assert!(!browser_args("https://stream.example.com").contains("unsafely"));
    }
}
