package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

var recognitionQuizImageURL = regexp.MustCompile(`^data/quiz_images/[A-Za-z0-9_.-]+\.(?i:jpe?g|png|gif|webp)$`)

// New writes use schema v2. Historical snapshots remain immutable; aliases are
// accepted at the write boundary so older editors can still save their drafts.
func recognitionValidateQuiz(quiz map[string]any) string {
	questions, ok := quiz["questions"].([]any)
	if !ok || len(questions) > 500 {
		return "题目数量非法（最多 500 题）"
	}
	for i, raw := range questions {
		q, ok := raw.(map[string]any)
		no := fmt.Sprintf("第 %d 题", i+1)
		if !ok || !containsString([]string{"single", "multiple", "judge", "fill_blank", "order", "fill_multi"}, stringValue(q["type"])) {
			return no + "题型不支持"
		}
		if strings.TrimSpace(stringValue(q["question"])) == "" {
			return no + "题干为空"
		}
		points, exists := q["points"]
		if !exists {
			points, exists = q["score"]
		}
		if !exists {
			points = 10
		}
		if integerValue(points) < 1 || integerValue(points) > 100 {
			return no + "分值需在 1–100 之间"
		}
		q["points"] = integerValue(points)
		delete(q, "score")
		q["explanation"] = strings.TrimSpace(stringValue(q["explanation"]))
		if len(stringValue(q["explanation"])) > 1500 {
			return no + "答案说明过长（最多 500 字）"
		}
		if image := stringValue(q["image"]); image != "" && !recognitionQuizImageURL.MatchString(image) {
			return no + "题干图片地址非法"
		}
		switch stringValue(q["type"]) {
		case "single", "multiple", "judge", "order":
			options, ok := q["options"].([]any)
			if !ok || len(options) < 2 {
				return no + "选项不足"
			}
			if stringValue(q["type"]) == "order" {
				if len(options) > 20 {
					return no + "排序题选项不能超过 20 个"
				}
				delete(q, "answer")
			} else {
				answers, ok := q["answer"].([]any)
				if !ok || len(answers) == 0 {
					return no + "未设置答案"
				}
				if stringValue(q["type"]) != "multiple" && len(answers) != 1 {
					return no + "单选或判断题只能有一个答案"
				}
				seen := map[int64]bool{}
				for _, answer := range answers {
					switch answer.(type) {
					case float64, int, int64, json.Number:
					default:
						return no + "答案索引必须为整数"
					}
					index := integerValue(answer)
					if floatValue(answer) != float64(index) || index < 0 || index >= int64(len(options)) || seen[index] {
						return no + "答案索引越界或重复"
					}
					seen[index] = true
				}
			}
			images := anySlice(q["option_images"])
			if len(images) > 0 {
				if len(images) != len(options) {
					return no + "选项图数量与选项不一致"
				}
				for _, image := range images {
					if value := stringValue(image); value != "" && !recognitionQuizImageURL.MatchString(value) {
						return no + "选项图地址非法"
					}
				}
			}
		case "fill_blank":
			if _, exists := q["answer_text"]; !exists {
				q["answer_text"] = q["answer"]
			}
			q["answer_text"] = strings.TrimSpace(stringValue(q["answer_text"]))
			if q["answer_text"] == "" {
				return no + "填空题缺少参考答案"
			}
			delete(q, "answer")
		case "fill_multi":
			if _, exists := q["answer_texts"]; !exists {
				q["answer_texts"] = q["answer"]
			}
			texts, ok := q["answer_texts"].([]any)
			if !ok || len(texts) < 1 || len(texts) > 10 {
				return no + "多空填空需 1–10 个空"
			}
			for j, text := range texts {
				texts[j] = strings.TrimSpace(stringValue(text))
				if texts[j] == "" {
					return no + "缺少参考答案"
				}
			}
			delete(q, "answer")
			delete(q, "answer_text")
		}
	}
	settings, _ := quiz["settings"].(map[string]any)
	if integerValue(settings["pick_count"]) > int64(len(questions)) {
		return "抽题数量不能超过总题数"
	}
	if integerValue(settings["time_limit"]) > 180 {
		return "限时不能超过 180 分钟"
	}
	mode := stringValue(settings["result_mode"])
	if mode != "" && !containsString([]string{"immediate", "pass_only", "hidden", "score", "detail"}, mode) {
		return "成绩显示模式非法"
	}
	quiz["settings"] = recognitionQuizSettings(quiz)
	quiz["schema_version"] = 2
	delete(quiz, "shuffle")
	return ""
}

func recognitionValidateConditions(value any, depth int) string {
	conditions, ok := value.([]any)
	if value == nil {
		return ""
	}
	if !ok || depth > 10 {
		return "conditions 必须为数组且嵌套不超过 10 层"
	}
	for _, raw := range conditions {
		condition, ok := raw.(map[string]any)
		if !ok || !containsString([]string{"score_gte", "eq", "gte", "lte", "contains", "all_of", "any_of", "time_window", "event_count_gte", "prerequisite_badge", "reviewer_count_gte", "submission_approved", "source_is"}, stringValue(condition["op"])) {
			return "不支持的规则组件"
		}
		if op := stringValue(condition["op"]); op == "all_of" || op == "any_of" {
			if err := recognitionValidateConditions(condition["conditions"], depth+1); err != "" {
				return err
			}
		}
	}
	return ""
}

func (s *Server) recognitionValidateContent(ctx context.Context, content map[string]any, typ string, clubID int64, country string) string {
	return recognitionValidateContentExec(ctx, s.db, content, typ, clubID, country)
}

func recognitionValidateContentExec(ctx context.Context, exec recognitionExec, content map[string]any, typ string, clubID int64, country string) string {
	if !containsString(recognitionProgramTypes, typ) {
		return "项目类型非法"
	}
	quiz, hasQuiz := content["quiz"].(map[string]any)
	if typ == "assessment" && (!hasQuiz || len(anySlice(quiz["questions"])) == 0) {
		return "答题类考核至少需要一道题目"
	}
	if hasQuiz {
		if err := recognitionValidateQuiz(quiz); err != "" {
			return err
		}
	}
	rules, ok := content["rules"].(map[string]any)
	if !ok {
		return "缺少完成规则（rules）"
	}
	if logic := stringValue(rules["logic"]); logic != "" && logic != "all" && logic != "any" {
		return "logic 只允许 all / any"
	}
	if err := recognitionValidateConditions(rules["conditions"], 0); err != "" {
		return err
	}
	award, _ := rules["award"].(map[string]any)
	var id int64
	if integerValue(award["badge_id"]) <= 0 || exec.QueryRowContext(ctx, "SELECT id FROM recognition_badges WHERE id=? AND club_id=? AND country=?", integerValue(award["badge_id"]), clubID, country).Scan(&id) != nil {
		return "奖励徽章不存在或不属于该同好会"
	}
	return ""
}
