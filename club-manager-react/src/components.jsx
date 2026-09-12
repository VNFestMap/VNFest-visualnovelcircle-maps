import React from 'react';
import { Alert, Avatar, Button, Card, Empty, Skeleton, Space, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { formatDate, mediaUrl } from './model.js';

export function PageHeading({ title, description, extra, action }) {
  return (
    <div className="cm-page-heading">
      <div className="cm-heading-copy">
        <Typography.Title level={2}>{title}</Typography.Title>
        {description && <Typography.Text type="secondary">{description}</Typography.Text>}
      </div>
      {(extra || action) && <Space className="cm-heading-actions" wrap>{extra || action}</Space>}
    </div>
  );
}

export function SectionHeading({ title, description, extra }) {
  return (
    <div className="cm-section-heading">
      <div className="cm-section-heading-copy">
        <Typography.Title level={4}>{title}</Typography.Title>
        {description && <Typography.Text type="secondary">{description}</Typography.Text>}
      </div>
      {extra && <Space className="cm-section-heading-extra" wrap>{extra}</Space>}
    </div>
  );
}

export function LoadingPanel({ rows = 3, variant = 'panel' }) {
  if (variant === 'management') {
    return (
      <div className="cm-management-list cm-loading-list" aria-busy="true" aria-label="正在加载列表">
        {Array.from({ length: Math.min(rows, 4) }, (_, index) => (
          <article className="cm-management-item cm-loading-item" key={index}>
            <div className="cm-loading-identity">
              <Skeleton.Avatar active size={34} shape="square" />
              <Skeleton active title={{ width: '72%' }} paragraph={{ rows: 1, width: '56%' }} />
            </div>
            <Skeleton active title={false} paragraph={{ rows: 2 }} />
            <Skeleton active title={{ width: '62%' }} paragraph={{ rows: 1, width: '84%' }} />
            <Skeleton.Button active size="small" />
          </article>
        ))}
      </div>
    );
  }

  if (variant === 'table') {
    return (
      <div className="cm-user-list-shell cm-loading-user-shell" aria-busy="true" aria-label="正在加载用户列表">
        <div className="cm-user-table-wrap cm-loading-table" aria-hidden="true">
          <div className="cm-loading-table-row is-heading">
            {Array.from({ length: 6 }, (_, index) => <Skeleton.Input active size="small" key={index} />)}
          </div>
          {Array.from({ length: Math.min(rows, 5) }, (_, rowIndex) => (
            <div className="cm-loading-table-row" key={rowIndex}>
              {Array.from({ length: 6 }, (_, columnIndex) => <Skeleton.Input active size="small" key={columnIndex} />)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <Card className="cm-panel"><Skeleton active paragraph={{ rows }} /></Card>;
}

export function ErrorPanel({ message, onRetry }) {
  return (
    <Alert
      type="error"
      showIcon
      message="加载失败"
      description={message}
      action={onRetry && <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>重试</Button>}
    />
  );
}

export function LoadingState({ label = '正在加载…' }) {
  return <div className="cm-tab-loading"><Skeleton active /><span>{label}</span></div>;
}

export function ErrorState({ description, onRetry }) {
  return <ErrorPanel message={description} onRetry={onRetry} />;
}

export function EmptyPanel({ description = '暂无记录', action }) {
  return (
    <Card className="cm-panel">
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />
      {action && <div className="cm-empty-action">{action}</div>}
    </Card>
  );
}

/* 22px 语义 chip —— 替代 antd Tag，避免大号色块抢视觉权重。 */
export function StatusChip({ status }) {
  if (status === 'active' || status === 'approved') return <span className="cm-chip is-success">已通过</span>;
  if (status === 'rejected') return <span className="cm-chip is-danger">已拒绝</span>;
  if (status === 'disabled' || status === 'banned') return <span className="cm-chip">已停用</span>;
  return <span className="cm-chip is-warning">待审核</span>;
}

export function Chip({ tone, children }) {
  return <span className={`cm-chip${tone ? ` is-${tone}` : ''}`}>{children}</span>;
}

export function Identity({ avatar, primary, secondary }) {
  return (
    <div className="cm-identity">
      {avatar}
      <div className="cm-identity-text">
        <strong title={typeof primary === 'string' ? primary : undefined}>{primary}</strong>
        {secondary && <small>{secondary}</small>}
      </div>
    </div>
  );
}

export function ProfileAvatar({ value, name, size = 34, shape = 'circle', className = '', alt = '' }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => { setFailed(false); }, [value]);
  const source = !failed && value ? mediaUrl(value) : '';
  const initial = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  const classes = ['cm-profile-avatar', source ? '' : 'is-fallback', className].filter(Boolean).join(' ');

  return (
    <Avatar
      className={classes}
      size={size}
      shape={shape}
      src={source || undefined}
      alt={alt || name || ''}
      onError={() => { setFailed(true); return false; }}
    >
      {initial}
    </Avatar>
  );
}

export function Timestamp({ value }) {
  return <time dateTime={value || undefined}>{formatDate(value)}</time>;
}

export function InlineNotice({ children }) {
  return <div className="cm-inline-notice">{children}</div>;
}

/*
 * 业务列表条目的布局骨架。
 *
 * 五个核心管理列表使用下面这些 slot 组件，让身份、正文、状态/设置和
 * 操作栏可以按业务分别排版，而不是被一套纵向字段行强行复用。
 */
export function ManagementItem({ identity, summary, context, details, status, settings, actions, className = '' }) {
  const hasContext = context || status || settings;
  const classes = [
    'cm-management-item',
    hasContext ? 'has-context' : '',
    actions ? 'has-actions' : 'is-readonly',
    className,
  ].filter(Boolean).join(' ');

  return (
    <article className={classes}>
      <div className="cm-item-identity" data-slot="identity">{identity}</div>
      <div className="cm-item-content" data-slot="summary">
        {summary}
        {details && <div className="cm-item-details" data-slot="details">{details}</div>}
      </div>
      {hasContext && (
        <div className="cm-item-context" data-slot="context">
          <div className="cm-item-context-stack">
            {status && <div className="cm-item-status" data-slot="status">{status}</div>}
            {context && <div className="cm-item-context-copy" data-slot="context-copy">{context}</div>}
            {settings && <div className="cm-item-settings" data-slot="settings">{settings}</div>}
          </div>
        </div>
      )}
      {actions && <div className="cm-item-actions" data-slot="actions">{actions}</div>}
    </article>
  );
}

export function MetaLine({ children, className = '' }) {
  return <div className={`cm-meta-line${className ? ` ${className}` : ''}`}>{children}</div>;
}

export function MetaItem({ label, value, className = '' }) {
  const title = typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  return (
    <span className={`cm-meta-item${className ? ` ${className}` : ''}`}>
      <span className="cm-meta-label">{label}</span>
      <span className="cm-meta-value" title={title}>{value}</span>
    </span>
  );
}

export function ActionCluster({ children, className = '' }) {
  return <div className={`cm-action-cluster${className ? ` ${className}` : ''}`}>{children}</div>;
}

export function DisclosureText({ value, empty = '未填写', label = '展开理由' }) {
  const [expanded, setExpanded] = React.useState(false);
  const detailsId = React.useId();

  if (!value) return <div className="cm-disclosure cm-disclosure-empty">{empty}</div>;

  return (
    <div className={`cm-disclosure${expanded ? ' is-expanded' : ''}`}>
      <p id={detailsId} className="cm-disclosure-copy">{value}</p>
      <button
        type="button"
        className="cm-disclosure-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? '收起理由' : label}
      </button>
    </div>
  );
}
