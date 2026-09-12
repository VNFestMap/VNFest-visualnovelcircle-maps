import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Slider } from 'antd';

const CANVAS_SIZE = 300;

export default function ImageCropModal({ file, open, onCancel, onCropped }) {
  const canvasRef = useRef(null);
  const imageRef = useRef(null);
  const drag = useRef(null);
  const zoomRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  /* Stable painter: it reads the live zoom/offset from refs so the image-loading
     effect never needs to depend on them (depending on them would re-create the
     object URL on every drag frame). */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    const currentZoom = zoomRef.current;
    const currentOffset = offsetRef.current;
    const side = Math.min(image.width, image.height) / currentZoom;
    const sx = Math.max(0, Math.min(image.width - side, (image.width - side) / 2 - currentOffset.x * side / CANVAS_SIZE));
    const sy = Math.max(0, Math.min(image.height - side, (image.height - side) / 2 - currentOffset.y * side / CANVAS_SIZE));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.drawImage(image, sx, sy, side, side, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }, []);

  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      zoomRef.current = 1;
      offsetRef.current = { x: 0, y: 0 };
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      requestAnimationFrame(draw);
    };
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [draw, file]);

  useEffect(() => {
    zoomRef.current = zoom;
    offsetRef.current = offset;
    draw();
  }, [draw, offset, zoom]);

  /* The canvas only exists while the dialog is mounted, so opening the dialog has
     to trigger a first paint on its own. */
  useEffect(() => { if (open) draw(); }, [draw, open]);

  const finish = () => canvasRef.current?.toBlob(
    (blob) => blob && onCropped(new File([blob], 'badge_crop.png', { type: 'image/png' })),
    'image/png',
  );

  return (
    <Modal title="裁剪徽章图片（1:1）" open={open} onCancel={onCancel} onOk={finish} destroyOnHidden>
      <div className="cm-crop">
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          onPointerDown={(event) => {
            drag.current = { x: event.clientX, y: event.clientY, offset };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            setOffset({ x: drag.current.offset.x + event.clientX - drag.current.x, y: drag.current.offset.y + event.clientY - drag.current.y });
          }}
          onPointerUp={() => { drag.current = null; }}
        />
        <div className="cm-crop-circle" />
      </div>
      <Slider min={1} max={6} step={0.05} value={zoom} onChange={setZoom} aria-label="图片缩放" />
    </Modal>
  );
}
