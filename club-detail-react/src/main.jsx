import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  normalizeClub,
  visibleContactUrl,
  externalPlatforms,
  appendComments,
  requestJson,
} from "./model.mjs";

const copy = {
  zh: {
    profile: "资料",
    community: "社区",
    intro: "同好会简介",
    emptyIntro: "介绍正在等待补充",
    introHint: "先从联系方式与对外平台了解这个同好会。",
    contact: "联系方式",
    restricted: "联系方式暂未对当前身份公开",
    loginHint: "登录后查看可用的加入方式。",
    restrictedHint: "可见范围由同好会设置与当前身份决定。",
    login: "登录 / 注册",
    apply: "申请加入同好会",
    pending: "申请审核中",
    member: "本会成员",
    manager: "管理者",
    owner: "负责人",
    exam: "参加考核",
    platforms: "对外平台",
    wiki: "同好会维基",
    readWiki: "阅读维基",
    editWiki: "编辑维基内容",
    manage: "我的同好会",
    edit: "编辑同好会信息",
    members: "成员名单",
    transfer: "转让负责人",
    leave: "退出同好会",
    registered: "已登记",
    unregistered: "未登记",
    unknownRegistration: "登记状态未知",
    date: "成立时间",
    unknownDate: "成立时间未知",
    region: "所在地区",
    school: "关联学校",
    noContact: "尚未填写联系方式",
    open: "打开联系链接",
    copy: "复制联系方式",
    copied: "已复制",
    copyFail: "复制失败，请手动选择并复制",
    recommendations: "神器推荐榜",
    noRecommendations: "暂未添加推荐",
    moe: "萌王",
    noMoe: "暂未设置萌王",
    comments: "留言板",
    noComments: "还没有留言，欢迎分享你的想法。",
    commentLogin: "登录并加入同好会后可留言。",
    commentJoin: "本会成员可以留言，你可以先申请加入。",
    placeholder: "分享你对这个同好会的想法…",
    publish: "发表",
    sending: "发送中…",
    more: "加载更多留言",
    loading: "加载中…",
    failed: "加载失败",
    retry: "重试",
    delete: "删除留言",
    deleteConfirm: "确定删除这条留言？",
    deleted: "留言已删除",
    sent: "留言已发表",
    noRating: "暂无评分",
    expand: "展开",
    collapse: "收起",
    close: "关闭同好会详情弹窗",
    unavailable: "操作失败，请重试",
    loadingWiki: "正在查询维基",
    wikiAbsent: "暂未建立公开维基",
    noPlatforms: "暂无对外平台",
    text: "文字联系方式",
    schoolType: "高校同好会",
    regionType: "地区联合",
    festivalType: "学园祭",
    noName: "未命名同好会",
    footer: "同好会档案",
    noImage: "暂无封面",
  },
  ja: {
    profile: "情報",
    community: "コミュニティ",
    intro: "同好会紹介",
    emptyIntro: "紹介文はまだありません",
    introHint: "連絡先や外部リンクから同好会を知ることができます。",
    contact: "連絡先",
    restricted: "現在のアカウントでは連絡先を表示できません",
    loginHint: "ログインして参加方法を確認してください。",
    restrictedHint:
      "公開範囲は同好会の設定とアカウントの状態によって異なります。",
    login: "ログイン / 登録",
    apply: "同好会への参加申請",
    pending: "申請審査中",
    member: "メンバー",
    manager: "管理者",
    owner: "代表者",
    exam: "認定試験に参加",
    platforms: "外部リンク",
    wiki: "同好会Wiki",
    readWiki: "Wikiを読む",
    editWiki: "Wikiを編集",
    manage: "所属同好会",
    edit: "同好会情報を編集",
    members: "メンバー一覧",
    transfer: "代表者を譲渡",
    leave: "同好会を退出",
    registered: "登録済み",
    unregistered: "未登録",
    unknownRegistration: "登録状況不明",
    date: "設立日",
    unknownDate: "設立日不明",
    region: "地域",
    school: "学校",
    noContact: "連絡先は未入力です",
    open: "連絡先を開く",
    copy: "連絡先をコピー",
    copied: "コピーしました",
    copyFail: "コピーできませんでした。手動でコピーしてください",
    recommendations: "おすすめ作品",
    noRecommendations: "おすすめ作品はありません",
    moe: "萌王",
    noMoe: "萌王は未設定です",
    comments: "コメント",
    noComments: "コメントはまだありません。",
    commentLogin: "ログインして同好会に参加するとコメントできます。",
    commentJoin: "同好会のメンバーがコメントできます。",
    placeholder: "同好会へのコメントを書く…",
    publish: "投稿",
    sending: "送信中…",
    more: "コメントをもっと見る",
    loading: "読み込み中…",
    failed: "読み込みに失敗しました",
    retry: "再試行",
    delete: "コメントを削除",
    deleteConfirm: "このコメントを削除しますか？",
    deleted: "削除しました",
    sent: "投稿しました",
    noRating: "評価なし",
    expand: "展開",
    collapse: "縮小",
    close: "同好会の詳細を閉じる",
    unavailable: "操作に失敗しました。再試行してください",
    loadingWiki: "Wikiを確認中",
    wikiAbsent: "公開Wikiはありません",
    noPlatforms: "外部リンクはありません",
    text: "テキスト連絡先",
    schoolType: "大学同好会",
    regionType: "地域大学連合",
    festivalType: "学園祭",
    noName: "名称未設定",
    footer: "同好会情報",
    noImage: "表紙なし",
  },
};

function useResource(loader) {
  const [revision, retry] = useState(0);
  const [state, set] = useState({ loading: true, data: null, error: false });
  useEffect(() => {
    const controller = new AbortController();
    set((old) => ({ ...old, loading: true, error: false }));
    Promise.resolve()
      .then(() => loader(controller.signal))
      .then((data) => {
        if (!controller.signal.aborted)
          set({ loading: false, data, error: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          set((old) => ({ ...old, loading: false, error: true }));
      });
    return () => controller.abort();
  }, [revision]);
  return { ...state, retry: () => retry((n) => n + 1) };
}

function Resource({ state, text, children }) {
  if (state.loading)
    return (
      <p className="cd-empty" role="status">
        {text.loading}
      </p>
    );
  if (state.error)
    return (
      <div className="cd-error" role="status">
        <span>{text.failed}</span>
        <button className="cd-text-button" onClick={state.retry}>
          {text.retry}
        </button>
      </div>
    );
  return children(state.data);
}

function Media({ src, alt = "", resolveMedia, className, placeholder }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed)
    return (
      <div
        className={`${className} cd-image-placeholder`}
        aria-label={placeholder}
      >
        {placeholder === "avatar" ? "◇" : "—"}
      </div>
    );
  return (
    <img
      className={className}
      src={resolveMedia(src)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function ClubDetail({ club: input, viewer, actions, helpers, lang }) {
  const club = normalizeClub(input);
  const text = copy[lang === "ja" ? "ja" : "zh"];
  const [tab, setTab] = useState("profile");
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [comments, setComments] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const rootRef = useRef();
  const tabsRef = useRef([]);
  const active = useRef(true);
  const mutations = useRef(new Set());
  const toastTimer = useRef();
  const query = new URLSearchParams({
    club_id: club.id,
    country: club.country,
  });
  const endpoint = (file, action) =>
    `./api/${file}.php?action=${action}&${query}`;
  const rec = useResource((signal) =>
    requestJson(endpoint("club_recommendations", "list"), { signal }).then(
      (r) => {
        if (!Array.isArray(r.data))
          throw new Error("Invalid recommendation response");
        return r.data;
      },
    ),
  );
  const moe = useResource((signal) =>
    requestJson(endpoint("club_moe_king", "get"), { signal }).then((r) => {
      if (
        r.data !== null &&
        (!r.data || Array.isArray(r.data) || typeof r.data !== "object")
      )
        throw new Error("Invalid moe response");
      return r.data;
    }),
  );
  const messages = useResource(async (signal) => {
    const result = await requestJson(
      `${endpoint("club_comments", "list")}&page=1&limit=20`,
      { signal },
    );
    if (!Array.isArray(result.data))
      throw new Error("Invalid comments response");
    if (!signal.aborted) {
      setComments(result.data);
      setPage(1);
      setTotal(Number(result.total) || 0);
    }
    return result;
  });
  const wiki = useResource((signal) => helpers.loadWiki(signal));

  const toast = (value) => {
    if (!active.current) return;
    setNotice(value);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setNotice(""), 4000);
  };
  useEffect(() => {
    const modal = document.getElementById("clubDetailModal");
    const card = modal.querySelector(".club-detail-modal-card");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const changed = [];
    let branch = modal;
    while (branch && branch !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (
          sibling !== branch &&
          !["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName) &&
          !sibling.inert
        ) {
          sibling.inert = true;
          changed.push(sibling);
        }
      }
      branch = branch.parentElement;
    }
    const focusable = () =>
      [
        ...card.querySelectorAll(
          'a[href],button:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
        ),
      ].filter((el) => el.getClientRects().length);
    const keydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        actions.close();
      }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0],
          last = items[items.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !card.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !card.contains(document.activeElement))
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    modal.querySelector("#clubDetailClose").focus();
    return () => {
      active.current = false;
      for (const controller of mutations.current) controller.abort();
      clearTimeout(toastTimer.current);
      document.body.style.overflow = previousOverflow;
      changed.forEach((el) => {
        el.inert = false;
      });
      document.removeEventListener("keydown", keydown, true);
    };
  }, []);
  useEffect(() => {
    const resize = () => {
      const modal = document.getElementById("clubDetailModal");
      const card = modal.querySelector(".club-detail-modal-card");
      if (window.innerWidth > 720) card.style.removeProperty("height");
      else
        card.style.setProperty(
          "height",
          `${Math.round(window.innerHeight * (expanded ? 0.92 : 0.62))}px`,
          "important",
        );
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [expanded]);

  const copyContact = async () => {
    try {
      await navigator.clipboard.writeText(club.contact);
      toast(text.copied);
    } catch {
      toast(text.copyFail);
    }
  };
  const post = async (action, body) => {
    const controller = new AbortController();
    mutations.current.add(controller);
    try {
      return await requestJson(`./api/club_comments.php?action=${action}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      mutations.current.delete(controller);
    }
  };
  const publish = async (event) => {
    event.preventDefault();
    if (sending || !draft.trim()) return;
    setSending(true);
    try {
      await post("add", {
        club_id: club.id,
        country: club.country,
        content: draft.trim(),
      });
      if (active.current) {
        setDraft("");
        messages.retry();
        toast(text.sent);
      }
    } catch (error) {
      if (error.name !== "AbortError") toast(text.unavailable);
    } finally {
      if (active.current) setSending(false);
    }
  };
  const remove = async (id) => {
    if (deleting !== null || !window.confirm(text.deleteConfirm)) return;
    setDeleting(id);
    try {
      await post("delete", { id });
      if (active.current) {
        setComments((items) =>
          items.filter((item) => String(item.id) !== String(id)),
        );
        setTotal((n) => Math.max(0, n - 1));
        toast(text.deleted);
      }
    } catch (error) {
      if (error.name !== "AbortError") toast(text.unavailable);
    } finally {
      if (active.current) setDeleting(null);
    }
  };
  const more = async () => {
    if (moreBusy) return;
    const controller = new AbortController();
    mutations.current.add(controller);
    setMoreBusy(true);
    setMoreError(false);
    try {
      const result = await requestJson(
        `${endpoint("club_comments", "list")}&page=${page + 1}&limit=20`,
        { signal: controller.signal },
      );
      if (!Array.isArray(result.data))
        throw new Error("Invalid comments response");
      if (active.current) {
        setComments((old) => appendComments(old, result.data));
        setPage((n) => n + 1);
        setTotal(Number(result.total) || 0);
      }
    } catch (error) {
      if (active.current && error.name !== "AbortError") setMoreError(true);
    } finally {
      mutations.current.delete(controller);
      if (active.current) setMoreBusy(false);
    }
  };
  const setSheet = (value) => {
    setExpanded(value);
    const modal = document.getElementById("clubDetailModal");
    modal.classList.toggle("club-detail-sheet-expanded", value);
    modal
      .querySelector(".club-detail-modal-card")
      .style.setProperty(
        "height",
        `${Math.round(window.innerHeight * (value ? 0.92 : 0.62))}px`,
        "important",
      );
  };
  const drag = useRef(null);
  const pointerDown = (event) => {
    if (window.innerWidth > 720) return;
    drag.current = {
      y: event.clientY,
      height: event.currentTarget
        .closest(".club-detail-modal-card")
        .getBoundingClientRect().height,
      delta: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document
      .getElementById("clubDetailModal")
      .classList.add("club-detail-sheet-dragging");
  };
  const pointerMove = (event) => {
    if (!drag.current) return;
    const delta = drag.current.y - event.clientY;
    drag.current.delta = delta;
    const height = Math.max(
      window.innerHeight * 0.35,
      Math.min(window.innerHeight * 0.92, drag.current.height + delta),
    );
    document
      .querySelector("#clubDetailModal .club-detail-modal-card")
      .style.setProperty("height", `${height}px`, "important");
  };
  const pointerUp = () => {
    if (!drag.current) return;
    document
      .getElementById("clubDetailModal")
      .classList.remove("club-detail-sheet-dragging");
    const { delta, height } = drag.current;
    drag.current = null;
    if (delta < -90 && height + delta < window.innerHeight * 0.5)
      actions.close();
    else setSheet(delta > 55 || height + delta > window.innerHeight * 0.77);
  };
  const contactUrl = !club.hidden ? visibleContactUrl(club.contact) : null;
  const platforms = externalPlatforms(club.external_links);
  const memberRole =
    viewer.role === "representative"
      ? text.owner
      : viewer.manage
        ? text.manager
        : text.member;
  const switchTab = (value) => {
    setTab(value);
    rootRef.current.querySelector(".cd-scroll").scrollTop = 0;
  };
  const introEmpty =
    !club.intro.trim() ||
    /^(暂无介绍|暂无备注|暂无介绍，欢迎补充[~～]?|備考なし)$/.test(
      club.intro.trim(),
    );
  return (
    <div className="cd-root" ref={rootRef}>
      <div className="cd-mobile-bar">
        <button className="cd-expand" onClick={() => setSheet(!expanded)}>
          {expanded ? text.collapse : text.expand}
        </button>
        <div
          className="cd-handle"
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
          aria-hidden="true"
        />
      </div>
      <header className="cd-header">
        <Media
          className="cd-avatar"
          src={club.logo_url}
          resolveMedia={helpers.resolveMedia}
          placeholder="avatar"
        />
        <div className="cd-identity">
          <div className="cd-eyebrow">VNFmap · {text.footer}</div>
          <h2 id="clubDetailTitle">{club.name || text.noName}</h2>
          <div className="cd-chips">
            <span>{helpers.region}</span>
            <span>
              {club.type === "region"
                ? text.regionType
                : club.type === "vnfest"
                  ? text.festivalType
                  : text.schoolType}
            </span>
            <span className={club.registered ? "cd-registered" : ""}>
              {club.registered === null
                ? text.unknownRegistration
                : club.registered
                  ? text.registered
                  : text.unregistered}
            </span>
            {viewer.member ? (
              <span>{memberRole}</span>
            ) : club.status === "pending" ? (
              <span>{text.pending}</span>
            ) : null}
          </div>
        </div>
      </header>
      <div className="cd-tabs" role="tablist" aria-label={text.footer}>
        {["profile", "community"].map((value, index) => (
          <button
            key={value}
            id={`cd-tab-${value}`}
            ref={(el) => (tabsRef.current[index] = el)}
            role="tab"
            aria-controls={`cd-panel-${value}`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => switchTab(value)}
            onKeyDown={(event) => {
              if (
                ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? 1
                      : 1 - index;
                tabsRef.current[next].focus();
              }
            }}
          >
            {text[value]}
          </button>
        ))}
        <span className="cd-tab-note">
          {club.country === "japan" ? "Japan" : "China"} ·{" "}
          {String(club.id).padStart(3, "0")}
        </span>
      </div>
      <div className="cd-scroll">
        <section
          id="cd-panel-profile"
          role="tabpanel"
          aria-labelledby="cd-tab-profile"
          tabIndex={0}
          hidden={tab !== "profile"}
        >
          <div className="cd-profile">
            <div className="cd-intro">
              <h3>{text.intro}</h3>
              {introEmpty ? (
                <div className="cd-intro-empty">
                  <span />
                  <strong>{text.emptyIntro}</strong>
                  <p>{text.introHint}</p>
                </div>
              ) : (
                <p className="cd-intro-text">{club.intro}</p>
              )}
              <dl className="cd-facts">
                <div>
                  <dt>{text.region}</dt>
                  <dd>{helpers.region}</dd>
                </div>
                <div>
                  <dt>{text.date}</dt>
                  <dd>
                    {club.established
                      ? helpers.formatDate(club.established)
                      : text.unknownDate}
                  </dd>
                </div>
                {club.school && (
                  <div>
                    <dt>{text.school}</dt>
                    <dd>{club.school}</dd>
                  </div>
                )}
              </dl>
            </div>
            <aside className="cd-resources">
              <div className="cd-contact">
                <h3>{text.contact}</h3>
                {club.hidden ? (
                  <>
                    <strong className="cd-contact-heading">
                      {text.restricted}
                    </strong>
                    <p>
                      {viewer.loggedIn ? text.restrictedHint : text.loginHint}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="cd-contact-value">
                      {club.contact || text.noContact}
                    </div>
                    {club.contact && (
                      <div className="cd-contact-buttons">
                        {contactUrl && (
                          <a
                            className="cd-button cd-primary"
                            href={contactUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {text.open} ↗
                          </a>
                        )}
                        <button
                          className={`cd-button ${contactUrl ? "" : "cd-primary"}`}
                          onClick={copyContact}
                        >
                          {text.copy}
                        </button>
                      </div>
                    )}
                  </>
                )}
                <div className="cd-join">
                  {!viewer.loggedIn ? (
                    club.hidden && (
                      <button
                        className="cd-button cd-primary"
                        onClick={actions.login}
                      >
                        {text.login}
                      </button>
                    )
                  ) : club.status === "pending" ? (
                    <p className="cd-status">{text.pending}</p>
                  ) : club.canApply && !viewer.member ? (
                    <button
                      className="cd-button cd-primary"
                      onClick={actions.apply}
                    >
                      {text.apply}
                    </button>
                  ) : null}
                  <button className="cd-text-button" onClick={actions.exam}>
                    {text.exam} →
                  </button>
                </div>
              </div>
              {platforms.length > 0 && (
                <section className="cd-links">
                  <h3>{text.platforms}</h3>
                  {platforms.map((platform, index) =>
                    platform.href ? (
                      <a
                        className="cd-link-row"
                        href={platform.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        key={index}
                      >
                        <strong>{platform.name}</strong>
                        <span>{platform.value}</span>
                        <i>↗</i>
                      </a>
                    ) : (
                      <div className="cd-link-row" key={index}>
                        <strong>{platform.name}</strong>
                        <span>{platform.value}</span>
                      </div>
                    ),
                  )}
                </section>
              )}
              <section className="cd-links" id="clubWikiSection">
                <h3>{text.wiki}</h3>
                <Resource state={wiki} text={text}>
                  {(index) => {
                    const entry = index[`${club.country}-${club.id}`];
                    const href = entry?.url ? helpers.wikiUrl(entry.url) : null;
                    return (
                      <div id="clubWikiActionWrap">
                        {href ? (
                          <a
                            className="cd-link-row"
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <strong>{text.readWiki}</strong>
                            <i>↗</i>
                          </a>
                        ) : (
                          <p className="cd-empty">{text.wikiAbsent}</p>
                        )}
                      </div>
                    );
                  }}
                </Resource>
              </section>
              {(viewer.member || viewer.manage) && (
                <details className="cd-management">
                  <summary>{text.manage}</summary>
                  <div className="club-detail-action-buttons cd-management-buttons">
                    {viewer.manage && (
                      <>
                        <button className="cd-button" onClick={actions.edit}>
                          {text.edit}
                        </button>
                        <button className="cd-button" onClick={actions.members}>
                          {text.members}
                        </button>
                        <a
                          className="cd-button"
                          href={helpers.wikiEditUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {text.editWiki} ↗
                        </a>
                      </>
                    )}
                    <div className="cd-danger-actions">
                      {viewer.role === "representative" && (
                        <button
                          className="cd-text-button"
                          onClick={actions.transfer}
                        >
                          {text.transfer}
                        </button>
                      )}
                      {viewer.member && (
                        <button
                          className="cd-text-button"
                          onClick={actions.leave}
                        >
                          {text.leave}
                        </button>
                      )}
                    </div>
                  </div>
                </details>
              )}
            </aside>
          </div>
        </section>
        <section
          id="cd-panel-community"
          role="tabpanel"
          aria-labelledby="cd-tab-community"
          tabIndex={0}
          hidden={tab !== "community"}
        >
          <div className="cd-community-top">
            <section className="cd-recommendations">
              <h3>{text.recommendations}</h3>
              <Resource state={rec} text={text}>
                {(items) =>
                  items.length ? (
                    <div className="cd-rec-grid">
                      {items.slice(0, 12).map((item, index) => (
                        <article key={item.id || index}>
                          <Media
                            className="cd-rec-image"
                            src={item.image_url}
                            resolveMedia={helpers.resolveMedia}
                            placeholder={text.noImage}
                            alt={item.title_cn || item.title}
                          />
                          <strong>
                            {item.title_cn ||
                              item.title ||
                              item.title_jp ||
                              item.bangumi_id}
                          </strong>
                          <span>
                            {item.rating === null ||
                            item.rating === undefined ||
                            item.rating === ""
                              ? text.noRating
                              : `★ ${item.rating}`}
                          </span>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="cd-empty">{text.noRecommendations}</p>
                  )
                }
              </Resource>
            </section>
            <section className="cd-moe">
              <h3>{text.moe}</h3>
              <Resource state={moe} text={text}>
                {(item) =>
                  item ? (
                    <div className="cd-moe-row">
                      <Media
                        className="cd-moe-image"
                        src={item.image_url}
                        resolveMedia={helpers.resolveMedia}
                        placeholder={text.noImage}
                        alt={item.name_cn || item.name}
                      />
                      <div>
                        <strong>
                          {item.name_cn || item.name || item.character_id}
                        </strong>
                        {item.summary && <p>{item.summary}</p>}
                      </div>
                    </div>
                  ) : (
                    <p className="cd-empty">{text.noMoe}</p>
                  )
                }
              </Resource>
            </section>
          </div>
          <section className="cd-comments">
            <h3>
              {text.comments}
              {messages.data && <span className="cd-count">{total}</span>}
            </h3>
            {viewer.member ? (
              <form className="cd-composer" onSubmit={publish}>
                <textarea
                  aria-label={text.comments}
                  value={draft}
                  disabled={sending}
                  maxLength={1000}
                  placeholder={text.placeholder}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div>
                  <small>{[...draft].length} / 1000</small>
                  <button
                    className="cd-button cd-primary"
                    disabled={sending || !draft.trim()}
                  >
                    {sending ? text.sending : text.publish}
                  </button>
                </div>
              </form>
            ) : (
              <p className="cd-comment-gate">
                {viewer.loggedIn ? text.commentJoin : text.commentLogin}
              </p>
            )}
            <Resource state={messages} text={text}>
              {() => (
                <>
                  {comments.length ? (
                    <div className="cd-comment-list">
                      {comments.map((item) => (
                        <article className="cd-comment" key={item.id}>
                          <div className="cd-comment-avatar">
                            {String(item.username || "?").slice(0, 1)}
                          </div>
                          <div className="cd-comment-body">
                            <div className="cd-comment-meta">
                              <strong>{item.username}</strong>
                              <time>{item.created_at}</time>
                              {(viewer.manage ||
                                (viewer.loggedIn &&
                                  Number(item.user_id) ===
                                    Number(viewer.userId))) && (
                                <button
                                  className="cd-delete"
                                  aria-label={text.delete}
                                  disabled={deleting !== null}
                                  onClick={() => remove(item.id)}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                            <p>{item.content}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="cd-empty">{text.noComments}</p>
                  )}
                  {comments.length < total && (
                    <button
                      className="cd-text-button"
                      disabled={moreBusy}
                      onClick={more}
                    >
                      {moreBusy
                        ? text.loading
                        : moreError
                          ? `${text.failed} · ${text.retry}`
                          : text.more}
                    </button>
                  )}
                </>
              )}
            </Resource>
          </section>
        </section>
      </div>
      <div
        className={`cd-toast ${notice ? "cd-toast-show" : ""}`}
        role="status"
        aria-live="polite"
      >
        {notice}
      </div>
    </div>
  );
}

let root;
window.VNFClubDetail = {
  mount(host, props) {
    root?.unmount();
    root = createRoot(host);
    root.render(<ClubDetail {...props} />);
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};
