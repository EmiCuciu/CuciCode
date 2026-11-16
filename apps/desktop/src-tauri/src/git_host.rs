use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::git_ops::{base_branch, branch_name, check_story_id, git};
use crate::secrets;

pub const GITHUB_TOKEN: &str = "CUCICODE_GITHUB_TOKEN";
pub const BITBUCKET_TOKEN: &str = "CUCICODE_BITBUCKET_TOKEN";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    GitHub,
    Bitbucket,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub kind: HostKind,
    pub domain: String,
    pub owner: String,
    pub repo: String,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

/// Reads host, owner and repository from an `origin` URL in https, ssh or scp form.
pub fn parse_remote(url: &str) -> Option<Remote> {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    let (domain, path) = if let Some((_, rest)) = url.split_once("://") {
        let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
        let (authority, path) = rest.split_once('/')?;
        (authority.split(':').next()?, path)
    } else {
        let (authority, path) = url.split_once(':')?;
        (authority.rsplit_once('@').map_or(authority, |(_, host)| host), path)
    };
    let (owner, repo) = path.rsplit_once('/')?;
    if domain.is_empty() || owner.is_empty() || repo.is_empty() || !domain.contains('.') {
        return None;
    }
    let lowered = domain.to_lowercase();
    let kind = if lowered.contains("github") {
        HostKind::GitHub
    } else if lowered.contains("bitbucket") {
        HostKind::Bitbucket
    } else {
        HostKind::Other
    };
    Some(Remote { kind, domain: domain.to_owned(), owner: owner.to_owned(), repo: repo.to_owned() })
}

#[derive(Debug, Clone, PartialEq)]
pub struct PullRequestCall {
    pub url: String,
    pub body: Value,
    pub token_name: &'static str,
    pub accept: &'static str,
}

/// The API request that opens a pull request on the remote's host.
pub fn pull_request_call(remote: &Remote, head: &str, base: &str, title: &str, description: &str) -> AppResult<PullRequestCall> {
    match remote.kind {
        HostKind::GitHub => {
            let api = if remote.domain.eq_ignore_ascii_case("github.com") { "https://api.github.com".to_owned() } else { format!("https://{}/api/v3", remote.domain) };
            Ok(PullRequestCall {
                url: format!("{api}/repos/{}/{}/pulls", remote.owner, remote.repo),
                body: json!({ "title": title, "head": head, "base": base, "body": description }),
                token_name: GITHUB_TOKEN,
                accept: "application/vnd.github+json",
            })
        }
        HostKind::Bitbucket => Ok(PullRequestCall {
            url: format!("https://api.bitbucket.org/2.0/repositories/{}/{}/pullrequests", remote.owner, remote.repo),
            body: json!({ "title": title, "description": description, "source": { "branch": { "name": head } }, "destination": { "branch": { "name": base } } }),
            token_name: BITBUCKET_TOKEN,
            accept: "application/json",
        }),
        HostKind::Other => Err(invalid(format!("pull requests are supported for GitHub and Bitbucket; {} is neither", remote.domain))),
    }
}

/// The page of the created pull request, from either host's response.
pub fn pull_request_link(response: &Value) -> Option<String> {
    response
        .get("html_url")
        .and_then(Value::as_str)
        .or_else(|| response.pointer("/links/html/href").and_then(Value::as_str))
        .map(str::to_owned)
}

fn api_error(response: &Value) -> String {
    let message = response.get("message").and_then(Value::as_str).or_else(|| response.pointer("/error/message").and_then(Value::as_str)).unwrap_or("no message");
    let details: Vec<&str> = response.get("errors").and_then(Value::as_array).into_iter().flatten().filter_map(|error| error.get("message").and_then(Value::as_str)).collect();
    if details.is_empty() {
        message.to_owned()
    } else {
        format!("{message}: {}", details.join("; "))
    }
}

fn post(call: &PullRequestCall, token: &str) -> AppResult<Value> {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let mut response = agent
        .post(&call.url)
        .header("Authorization", &format!("Bearer {token}"))
        .header("Accept", call.accept)
        .header("Content-Type", "application/json")
        .header("User-Agent", "cucicode")
        .send(call.body.to_string())
        .map_err(|error| invalid(format!("could not reach the git host: {error}")))?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        return Ok(parsed);
    }
    Err(invalid(format!("the git host refused the pull request (HTTP {status}): {}", api_error(&parsed))))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedPullRequest {
    pub url: String,
    pub branch: String,
    pub base: String,
}

pub fn origin(project: &Path) -> AppResult<Remote> {
    let url = git(project, &["remote", "get-url", "origin"]).map_err(|_| invalid("the project has no remote named origin"))?;
    parse_remote(&url).ok_or_else(|| invalid(format!("cannot read host, owner and repository from the origin URL {}", url.trim())))
}

/// Pushes the story branch and opens a pull request for it against the base branch.
pub fn open_pull_request(project: &Path, story_id: &str, title: &str, description: &str) -> AppResult<OpenedPullRequest> {
    check_story_id(story_id)?;
    let remote = origin(project)?;
    let base = base_branch(project)?;
    let branch = branch_name(story_id);
    let call = pull_request_call(&remote, &branch, &base, title, description)?;
    let token = secrets::get(call.token_name)?.ok_or_else(|| invalid(format!("no token is stored for {}; add one in Settings → Workflow → Git", remote.domain)))?;
    git(project, &["push", "-u", "origin", &branch])?;
    let response = post(&call, &token)?;
    let url = pull_request_link(&response).ok_or_else(|| invalid("the git host created the pull request but did not return its address"))?;
    Ok(OpenedPullRequest { url, branch, base })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(url: &str) -> Remote {
        parse_remote(url).unwrap_or_else(|| panic!("{url} should parse"))
    }

    #[test]
    fn parses_the_common_remote_url_forms() {
        assert_eq!(remote("https://github.com/acme/app.git"), Remote { kind: HostKind::GitHub, domain: "github.com".into(), owner: "acme".into(), repo: "app".into() });
        assert_eq!(remote("git@github.com:acme/app.git"), remote("https://github.com/acme/app"));
        assert_eq!(remote("ssh://git@bitbucket.org/team/service.git").kind, HostKind::Bitbucket);
        assert_eq!(remote("https://user:token@bitbucket.org/team/service/"), Remote { kind: HostKind::Bitbucket, domain: "bitbucket.org".into(), owner: "team".into(), repo: "service".into() });
        assert_eq!(remote("ssh://git@github.example.com:2222/platform/tools.git"), Remote { kind: HostKind::GitHub, domain: "github.example.com".into(), owner: "platform".into(), repo: "tools".into() });
        assert_eq!(remote("https://gitlab.com/group/sub/project.git"), Remote { kind: HostKind::Other, domain: "gitlab.com".into(), owner: "group/sub".into(), repo: "project".into() });
    }

    #[test]
    fn rejects_urls_without_host_owner_and_repository() {
        for url in ["", "../local/repo", r"C:\repos\origin.git", "https://github.com/onlyowner", "localhost:repo"] {
            assert_eq!(parse_remote(url), None, "{url:?}");
        }
    }

    #[test]
    fn builds_the_github_request_including_enterprise_hosts() {
        let call = pull_request_call(&remote("git@github.com:acme/app.git"), "story/S-001", "main", "S-001: login", "Body").unwrap();
        assert_eq!(call.url, "https://api.github.com/repos/acme/app/pulls");
        assert_eq!(call.body, json!({ "title": "S-001: login", "head": "story/S-001", "base": "main", "body": "Body" }));
        assert_eq!(call.token_name, GITHUB_TOKEN);
        let enterprise = pull_request_call(&remote("https://github.example.com/platform/tools.git"), "b", "main", "t", "").unwrap();
        assert_eq!(enterprise.url, "https://github.example.com/api/v3/repos/platform/tools/pulls");
    }

    #[test]
    fn builds_the_bitbucket_request_and_refuses_other_hosts() {
        let call = pull_request_call(&remote("git@bitbucket.org:team/service.git"), "story/S-002", "develop", "S-002", "Body").unwrap();
        assert_eq!(call.url, "https://api.bitbucket.org/2.0/repositories/team/service/pullrequests");
        assert_eq!(call.body["source"]["branch"]["name"], json!("story/S-002"));
        assert_eq!(call.body["destination"]["branch"]["name"], json!("develop"));
        assert_eq!(call.token_name, BITBUCKET_TOKEN);
        assert!(pull_request_call(&remote("https://gitlab.com/g/p.git"), "b", "main", "t", "").is_err());
    }

    #[test]
    fn reads_the_link_and_the_error_from_either_host() {
        assert_eq!(pull_request_link(&json!({ "html_url": "https://github.com/acme/app/pull/7" })).as_deref(), Some("https://github.com/acme/app/pull/7"));
        assert_eq!(pull_request_link(&json!({ "links": { "html": { "href": "https://bitbucket.org/t/s/pull-requests/3" } } })).as_deref(), Some("https://bitbucket.org/t/s/pull-requests/3"));
        assert_eq!(pull_request_link(&json!({})), None);
        assert_eq!(api_error(&json!({ "message": "Validation Failed", "errors": [{ "message": "A pull request already exists" }] })), "Validation Failed: A pull request already exists");
        assert_eq!(api_error(&json!({ "error": { "message": "Branch not found" } })), "Branch not found");
    }
}
