import React from 'react';
import { Button, Card, Checkbox, Input, InputNumber, Select, Space } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';

export const QUESTION_TYPES = [
  ['single', '单选题'], ['multiple', '多选题'], ['judge', '判断题'], ['fill_blank', '填空题'], ['order', '排序题'], ['fill_multi', '多空填空'],
];
const fresh = () => ({ type: 'single', question: '', score: 10, options: ['选项 A', '选项 B'], answer: [0], image: '', option_images: [] });
const normalizeAnswer = (answer) => Array.isArray(answer) ? answer : answer === undefined || answer === null ? [] : [answer];

export default function QuestionEditor({ value = [], onChange }) {
  const update = (index, patch) => onChange(value.map((item, i) => i === index ? { ...item, ...patch } : item));
  const move = (index, by) => {
    const next = [...value]; const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  const changeType = (index, type) => update(index, {
    type,
    options: ['single', 'multiple', 'judge', 'order'].includes(type)
      ? (type === 'judge' ? ['正确', '错误'] : value[index].options?.length ? value[index].options : ['选项 A', '选项 B'])
      : [],
    answer: type === 'multiple' || type === 'fill_multi' ? [] : type === 'order' ? [0, 1] : type === 'judge' ? [0] : '',
  });

  return (
    <div className="cm-question-list">
      {value.map((question, index) => {
        const options = question.options || [];
        const answers = normalizeAnswer(question.answer);
        return (
          <Card
            size="small"
            className="cm-question-card"
            key={question.id || index}
            title={`第 ${index + 1} 题`}
            extra={(
              <Space className="cm-question-actions" size={4}>
                <Button size="small" aria-label="上移题目" icon={<ArrowUpOutlined />} disabled={!index} onClick={() => move(index, -1)} />
                <Button size="small" aria-label="下移题目" icon={<ArrowDownOutlined />} disabled={index === value.length - 1} onClick={() => move(index, 1)} />
                <Button size="small" danger aria-label="删除题目" icon={<DeleteOutlined />} onClick={() => onChange(value.filter((_, i) => i !== index))} />
              </Space>
            )}
          >
            <Space wrap className="cm-question-meta">
              <Select size="small" value={question.type} options={QUESTION_TYPES.map(([v, label]) => ({ value: v, label }))} onChange={(type) => changeType(index, type)} />
              <InputNumber size="small" value={question.score ?? 10} min={1} addonAfter="分" onChange={(score) => update(index, { score })} />
            </Space>
            <Input.TextArea className="cm-question-input" value={question.question ?? question.title ?? ''} placeholder="题目内容" rows={2} onChange={(e) => update(index, { question: e.target.value, title: e.target.value })} />
            <Input size="small" className="cm-question-input" value={question.image || ''} placeholder="题目图片路径（可选）" onChange={(e) => update(index, { image: e.target.value })} />
            {['single', 'multiple', 'judge', 'order'].includes(question.type) && (
              <div className="cm-question-options">
                {options.map((option, optionIndex) => (
                  <div className="cm-question-option" key={optionIndex}>
                    <span className="cm-option-marker">
                      {question.type === 'multiple'
                        ? <Checkbox checked={answers.map(Number).includes(optionIndex)} onChange={(e) => update(index, { answer: e.target.checked ? [...answers.map(Number), optionIndex] : answers.map(Number).filter((x) => x !== optionIndex) })} />
                        : question.type !== 'order'
                          ? <input type="radio" name={`q-${index}`} checked={Number(answers[0]) === optionIndex} onChange={() => update(index, { answer: [optionIndex] })} />
                          : <span className="cm-option-order">{optionIndex + 1}</span>}
                    </span>
                    <Input size="small" className="cm-option-text" value={option} onChange={(e) => update(index, { options: options.map((item, i) => i === optionIndex ? e.target.value : item) })} />
                    <Input size="small" className="cm-option-image" value={(question.option_images || [])[optionIndex] || ''} placeholder="选项图片" onChange={(e) => { const images = [...(question.option_images || [])]; images[optionIndex] = e.target.value; update(index, { option_images: images }); }} />
                    {question.type === 'order' && (
                      <Space.Compact className="cm-option-reorder">
                        <Button size="small" aria-label={`上移选项 ${optionIndex + 1}`} icon={<ArrowUpOutlined />} disabled={!optionIndex} onClick={() => { const next = [...options]; [next[optionIndex - 1], next[optionIndex]] = [next[optionIndex], next[optionIndex - 1]]; update(index, { options: next, answer: next.map((_, i) => i) }); }} />
                        <Button size="small" aria-label={`下移选项 ${optionIndex + 1}`} icon={<ArrowDownOutlined />} disabled={optionIndex === options.length - 1} onClick={() => { const next = [...options]; [next[optionIndex + 1], next[optionIndex]] = [next[optionIndex], next[optionIndex + 1]]; update(index, { options: next, answer: next.map((_, i) => i) }); }} />
                      </Space.Compact>
                    )}
                    {question.type !== 'judge' && <Button size="small" className="cm-option-remove" danger type="text" aria-label={`删除选项 ${optionIndex + 1}`} icon={<DeleteOutlined />} onClick={() => update(index, { options: options.filter((_, i) => i !== optionIndex), answer: answers.filter((x) => Number(x) !== optionIndex) })} />}
                  </div>
                ))}
                {question.type !== 'judge' && <Button size="small" className="cm-add-option" block type="dashed" icon={<PlusOutlined />} onClick={() => update(index, { options: [...options, `选项 ${String.fromCharCode(65 + options.length)}`] })}>添加选项</Button>}
              </div>
            )}
            {question.type === 'fill_blank' && <Input size="small" className="cm-question-input" value={String(question.answer ?? '')} placeholder="标准答案" onChange={(e) => update(index, { answer: e.target.value })} />}
            {question.type === 'fill_multi' && <Input size="small" className="cm-question-input" value={answers.join(' | ')} placeholder="按空顺序填写答案，以 | 分隔" onChange={(e) => update(index, { answer: e.target.value.split('|').map((x) => x.trim()) })} />}
          </Card>
        );
      })}
      <Button className="cm-add-question" type="dashed" block icon={<PlusOutlined />} onClick={() => onChange([...value, fresh()])}>添加题目</Button>
    </div>
  );
}
