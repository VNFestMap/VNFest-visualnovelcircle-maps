package httpapi

// A paper belongs to an attempt, not to the submitted request. Reject damaged
// historical snapshots rather than silently assembling a different exam.
func recognitionPaperQuestions(content map[string]any, paper []any) ([]any, bool) {
	quiz, _ := content["quiz"].(map[string]any)
	questions := anySlice(quiz["questions"])
	if len(paper) == 0 || len(paper) > len(questions) {
		return nil, false
	}
	seen := map[int64]bool{}
	picked := make([]any, 0, len(paper))
	for i, raw := range paper {
		row, ok := raw.(map[string]any)
		origValue, hasOrig := row["orig"]
		seqValue, hasSeq := row["seq"]
		orig := integerValue(origValue)
		if !ok || !hasOrig || !hasSeq || floatValue(origValue) != float64(orig) || integerValue(seqValue) != int64(i) || orig < 0 || orig >= int64(len(questions)) || seen[orig] {
			return nil, false
		}
		seen[orig] = true
		picked = append(picked, questions[orig])
	}
	return picked, true
}

func recognitionStripPaperAnswers(paper []any) []any {
	result := make([]any, 0, len(paper))
	for _, raw := range paper {
		row, _ := raw.(map[string]any)
		result = append(result, recognitionStripAnswers(row))
	}
	return result
}

func recognitionUniqueInts(values []int) []int {
	seen := map[int]bool{}
	result := []int{}
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}
