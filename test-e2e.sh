#!/bin/bash

# End-to-End API Testing Script
# Usage: ./test-e2e.sh

# Configuration
LOCAL_URL="http://localhost:3000"
# Uncomment and set to test against AWS
# AWS_URL="https://your-api-gateway-url.execute-api.ap-south-1.amazonaws.com/prod"

# Choose which environment to test
BASE_URL="$LOCAL_URL"
# BASE_URL="$AWS_URL"

PASSED=0
FAILED=0

function test_endpoint {
    local name="$1"
    local method="$2"
    local path="$3"
    local body="$4"
    
    echo ""
    echo "🧪 $name"
    echo "   $method $path"
    
    if [ -n "$body" ]; then
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$BASE_URL$path" \
            -H "Content-Type: application/json" \
            -d "$body")
    else
        response=$(curl -s -w "\n%{http_code}" -X "$method" "$BASE_URL$path" \
            -H "Content-Type: application/json")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body_response=$(echo "$response" | head -n -1)
    
    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
        echo "   ✅ Success (HTTP $http_code)"
        echo "$body_response" | jq '.' 2>/dev/null || echo "$body_response"
        ((PASSED++))
        return 0
    else
        echo "   ❌ Failed (HTTP $http_code)"
        echo "$body_response"
        ((FAILED++))
        return 1
    fi
}

echo "═══════════════════════════════════════════════════════"
echo "  End-to-End API Testing"
echo "  Target: $BASE_URL"
echo "═══════════════════════════════════════════════════════"

# Test 1: Get Ledger (all actions)
test_endpoint "Get All Actions Ledger" "GET" "/ledger" ""
ACTION_ID=$(curl -s "$BASE_URL/ledger" | jq -r '.items[0].action_id // "12345"')
echo "   ℹ️  Using action_id: $ACTION_ID"

# Test 2: Get Ledger (filtered by client)
test_endpoint "Get Actions Ledger (filtered)" "GET" "/ledger?client_id=C001" ""

# Test 3: Shelfware Report
test_endpoint "Get Shelfware Report" "GET" "/reports/shelfware" ""

# Test 4: Underbilling Report
test_endpoint "Get Underbilling Report" "GET" "/reports/underbilling" ""

# Test 5: Approve Action (basic)
test_endpoint "Approve Action (basic)" "POST" "/actions/$ACTION_ID/approve" "{}"

# Test 6: Approve Action (with custom savings)
test_endpoint "Approve Action (with savings)" "POST" "/actions/$ACTION_ID/approve" \
    '{"est_saving_inr": 50000, "send_email": false}'

# Test 7: QBR PDF Report
test_endpoint "Generate QBR PDF" "POST" "/qbr/pdf" \
    '{"client_id": "C001", "period": "2025-09"}'

# Test 8: Policies Evaluate (Local only)
if [ "$BASE_URL" = "$LOCAL_URL" ]; then
    test_endpoint "Evaluate Policies" "POST" "/policies/evaluate" "{}"
fi

# Test 9: Bootstrap (will work on AWS, may fail locally)
if [ "$BASE_URL" != "$LOCAL_URL" ]; then
    test_endpoint "Bootstrap Athena Views" "POST" "/admin/bootstrap" "{}"
else
    echo ""
    echo "⏭️  Skipping /admin/bootstrap (requires AWS Athena)"
fi

# Summary
TOTAL=$((PASSED + FAILED))
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Test Summary"
echo "═══════════════════════════════════════════════════════"
echo "  Total:  $TOTAL"
echo "  Passed: $PASSED"
echo "  Failed: $FAILED"
echo ""
echo "✅ Testing complete!"

if [ $FAILED -gt 0 ]; then
    exit 1
else
    exit 0
fi
