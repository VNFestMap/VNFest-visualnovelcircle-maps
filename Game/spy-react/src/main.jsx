import React from 'react';
import { createRoot } from 'react-dom/client';

// Spark Design 整包样式（含 Tailwind v4 运行时、scale 与组件层）
import 'sparkdesign/style';

// VNFest 站点令牌桥接层 + 原型布局层（必须在 Spark 之后引入，以便覆盖 --token-color-*）
import './styles.css';

import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
